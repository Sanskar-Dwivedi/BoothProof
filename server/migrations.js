import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MINT } from './solana.js';
import { reconcileInvoice } from './invoices.js';

export const SCHEMA_VERSION = 1;

const legacySchema = `
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('demo','devnet')),
    title TEXT NOT NULL, amount_units INTEGER NOT NULL CHECK(amount_units > 0),
    recipient TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, accepted_signature TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS evidence (
    signature TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
    kind TEXT NOT NULL CHECK(kind IN ('exact','amount','mint','recipient','balance')),
    slot INTEGER NOT NULL, amount TEXT NOT NULL, decimals INTEGER NOT NULL, observed_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS evidence_order ON evidence(order_id,slot);
  CREATE INDEX IF NOT EXISTS orders_mode ON orders(mode,created_at DESC);
  CREATE TABLE IF NOT EXISTS invoices (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), mode TEXT NOT NULL CHECK(mode IN ('demo','devnet')),
    invoice_number TEXT NOT NULL, number_key TEXT NOT NULL, client TEXT NOT NULL, due_date TEXT NOT NULL,
    UNIQUE(mode,number_key)
  ) STRICT;
`;

const recoverySchema = `
  ALTER TABLE invoices ADD COLUMN deposit_units INTEGER CHECK(deposit_units IS NULL OR deposit_units > 0);
  CREATE TRIGGER invoice_deposit_insert BEFORE INSERT ON invoices
    WHEN NEW.deposit_units >= (SELECT amount_units FROM orders WHERE id = NEW.order_id)
    BEGIN SELECT RAISE(ABORT,'Deposit must be below invoice total'); END;
  CREATE TRIGGER invoice_deposit_update BEFORE UPDATE OF deposit_units ON invoices
    WHEN NEW.deposit_units >= (SELECT amount_units FROM orders WHERE id = NEW.order_id)
    BEGIN SELECT RAISE(ABORT,'Deposit must be below invoice total'); END;
  CREATE TABLE payments (
    signature TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('demo','devnet')),
    recipient TEXT NOT NULL, mint TEXT NOT NULL,
    amount_units TEXT NOT NULL CHECK(amount_units NOT GLOB '*[^0-9]*' AND length(amount_units)>0 AND substr(amount_units,1,1) BETWEEN '1' AND '9'),
    slot INTEGER NOT NULL CHECK(slot>=0), chain_time TEXT, verified_at TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('rpc','demo','legacy')),
    source_owner TEXT, source_account TEXT, destination_account TEXT, instruction_index INTEGER,
    bound_order_id TEXT REFERENCES orders(id), suggested_invoice_id TEXT REFERENCES invoices(order_id),
    allocated_order_id TEXT REFERENCES orders(id), allocation_method TEXT CHECK(allocation_method IN ('reference','manual','legacy')),
    allocation_version INTEGER NOT NULL DEFAULT 0 CHECK(allocation_version>=0), allocated_at TEXT,
    CHECK((allocated_order_id IS NULL AND allocation_method IS NULL AND allocated_at IS NULL) OR
          (allocated_order_id IS NOT NULL AND allocation_method IS NOT NULL AND allocated_at IS NOT NULL)),
    CHECK(bound_order_id IS NULL OR allocated_order_id = bound_order_id),
    CHECK(provenance<>'demo' OR mode='demo'), CHECK(provenance<>'rpc' OR mode='devnet')
  ) STRICT;
  CREATE INDEX payments_mode_allocation ON payments(mode,allocated_order_id);
  CREATE INDEX payments_invoice ON payments(allocated_order_id,verified_at);
  CREATE TRIGGER payment_facts_immutable BEFORE UPDATE OF signature,mode,recipient,mint,amount_units,slot,chain_time,verified_at,provenance,source_owner,source_account,destination_account,instruction_index,bound_order_id ON payments
    BEGIN SELECT RAISE(ABORT,'Verified payment facts are immutable'); END;
  CREATE TRIGGER payments_preserve BEFORE DELETE ON payments
    BEGIN SELECT RAISE(ABORT,'Verified payment facts must be preserved'); END;
  CREATE TABLE review_cases (
    id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(order_id), case_key TEXT NOT NULL,
    signature TEXT, reason TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
    state TEXT NOT NULL CHECK(state IN ('open','acknowledged','cleared')),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), financial_fingerprint TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(invoice_id,case_key)
  ) STRICT;
  CREATE INDEX review_open ON review_cases(state,invoice_id);
  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payment_signature TEXT REFERENCES payments(signature),
    invoice_id TEXT REFERENCES orders(id), case_id TEXT REFERENCES review_cases(id), resulting_version INTEGER,
    actor TEXT NOT NULL CHECK(actor IN ('system','local_operator','migration','demo')),
    timestamp TEXT NOT NULL, request_fingerprint TEXT, details TEXT NOT NULL CHECK(json_valid(details))
  ) STRICT;
  CREATE INDEX audit_invoice_time ON audit_events(invoice_id,timestamp);
  CREATE INDEX audit_payment_time ON audit_events(payment_signature,timestamp);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit history is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit history is append-only'); END;
  CREATE TABLE invoice_sync (
    invoice_id TEXT PRIMARY KEY REFERENCES invoices(order_id), completed_watermark TEXT,
    active_scan INTEGER NOT NULL DEFAULT 0 CHECK(active_scan IN (0,1)), scan_head TEXT, cursor TEXT,
    pending_page TEXT CHECK(pending_page IS NULL OR json_valid(pending_page)), next_attempt TEXT,
    last_attempt TEXT, last_complete TEXT, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    financial_changed_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sync_due ON invoice_sync(next_attempt,last_attempt);
`;

export function backupDatabase(db, file, now) {
  const directory = join(dirname(file), 'backups');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `boothproof-${now.replaceAll(':','-')}-${randomUUID()}.sqlite`);
  // VACUUM INTO includes committed WAL activity; copying the main file does not.
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

export function migrate(db, { file = ':memory:', now = new Date().toISOString(), backup = backupDatabase, validateBackfill } = {}) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}. Startup stopped.`);
  if (version === SCHEMA_VERSION) return { version, backup: null };
  const existing = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='orders'").get());
  let backupPath = null;
  if (existing && file !== ':memory:') {
    try { backupPath = backup(db, file, now); }
    catch (error) { throw new Error('Database backup failed; migration was not started.', { cause: error }); }
    if (!backupPath) throw new Error('Database backup failed; migration was not started.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(legacySchema);
    const beforeOrders = db.prepare('SELECT * FROM orders ORDER BY id').all();
    const beforeEvidence = db.prepare('SELECT * FROM evidence ORDER BY signature').all();
    const invoices = db.prepare('SELECT orders.*,invoices.* FROM orders JOIN invoices ON order_id=id').all();
    const beforeBalances = invoices.map(order => reconcileInvoice(order, order.amount_units, beforeEvidence.filter(e => e.order_id===order.id)));
    db.exec(recoverySchema);
    const insert = db.prepare(`INSERT INTO payments
      (signature,mode,recipient,mint,amount_units,slot,chain_time,verified_at,provenance,bound_order_id,allocated_order_id,allocation_method,allocation_version,allocated_at)
      VALUES (?,?,?,?,?,?,?,?, 'legacy',?,?, 'legacy',1,?)`);
    const event = db.prepare(`INSERT INTO audit_events (id,kind,payment_signature,invoice_id,case_id,actor,timestamp,details)
      VALUES (?,?,?,?,?,'migration',?,?)`);
    for (const entry of beforeEvidence) {
      const order = beforeOrders.find(row => row.id===entry.order_id);
      if (entry.kind==='exact' || entry.kind==='amount') {
        insert.run(entry.signature,order.mode,order.recipient,MINT,BigInt(entry.amount).toString(),entry.slot,null,now,
          order.id,order.id,entry.observed_at);
        event.run(randomUUID(),'legacy_allocation',entry.signature,order.id,null,now,
          JSON.stringify({ amount_units: BigInt(entry.amount).toString(), note: 'Preserved original evidence and order association; historical chain time and source unknown.' }));
      } else if (invoices.some(invoice => invoice.id===order.id)) {
        const caseId = randomUUID();
        db.prepare(`INSERT INTO review_cases VALUES (?,?,?,?,?,?,'open',0,NULL,?,?)`).run(
          caseId,order.id,`signature:${entry.signature}`,entry.signature,entry.kind,JSON.stringify(entry),now,now);
        event.run(randomUUID(),'exception_observed',null,order.id,caseId,now,JSON.stringify({ reason: entry.kind }));
      }
    }
    for (const [index, order] of invoices.entries()) {
      const payments = db.prepare('SELECT * FROM payments WHERE allocated_order_id=? ORDER BY signature').all(order.id);
      const after = reconcileInvoice(order,order.amount_units,payments.map(p => ({kind:'amount',amount:p.amount_units,observed_at:p.allocated_at})));
      for (const field of ['expected_units','received_units','remaining_units','overpaid_units']) {
        if (beforeBalances[index][field]!==after[field]) throw new Error(`Migration balance mismatch for ${order.id}: ${field}`);
      }
      if (BigInt(after.overpaid_units)>0n) {
        const caseId=randomUUID();
        const fingerprint=JSON.stringify([after.overpaid_units,payments.map(p=>[p.signature,p.allocation_version])]);
        db.prepare(`INSERT INTO review_cases VALUES (?,?, 'overpayment',NULL,'overpayment',?,'open',0,?,?,?)`).run(
          caseId,order.id,JSON.stringify({ excess_units:after.overpaid_units }),fingerprint,now,now);
        event.run(randomUUID(),'overpayment_observed',null,order.id,caseId,now,JSON.stringify({ excess_units:after.overpaid_units }));
      }
      db.prepare('INSERT INTO invoice_sync (invoice_id,next_attempt,financial_changed_at) VALUES (?,?,?)').run(order.id,order.mode==='devnet'?now:null,now);
    }
    if (JSON.stringify(beforeOrders)!==JSON.stringify(db.prepare('SELECT * FROM orders ORDER BY id').all()) ||
        JSON.stringify(beforeEvidence)!==JSON.stringify(db.prepare('SELECT * FROM evidence ORDER BY signature').all())) {
      throw new Error('Migration changed legacy orders, receipts or evidence.');
    }
    validateBackfill?.(db);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Migration integrity or foreign-key validation failed.');
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
    return { version:SCHEMA_VERSION, backup:backupPath };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
