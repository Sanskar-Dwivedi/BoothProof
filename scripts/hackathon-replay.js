// Rebuild the saved invoice header in a new ledger. The ordinary app verifies both receipts on Devnet.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createDevnetRpc, isAddress, isSignature } from '../server/solana.js';
import { openStore } from '../server/store.js';
import { createWalletHandoff } from './devnet-wallet.js';

const output = new URL('../output/playwright/', import.meta.url);
const run = JSON.parse(readFileSync(new URL('devnet-acceptance-20261106.json', output), 'utf8'));
const appOrigin = 'http://127.0.0.1:4180';
const walletOrigin = 'http://127.0.0.1:4181';
if (run.live_acceptance !== 'complete' || !isAddress(run.payer) || run.payer === run.receiver) {
  throw new Error('A completed two-wallet Devnet acceptance record is required.');
}

const proofs = Object.values(run.transactions).filter(({ payment }) => payment?.source_owner === run.payer &&
  payment.recipient === run.receiver && payment.provenance === 'rpc');
const direct = proofs.find(({ payment }) => payment.amount_units === '30000000' && payment.bound_order_id === null);
const balance = proofs.find(({ payment }) => payment.amount_units === '20000000' && payment.bound_order_id === run.invoice_id);
if (!isSignature(direct?.signature) || !isSignature(balance?.signature) || direct.signature === balance.signature) {
  throw new Error('Both finalized payment signatures are required for the replay.');
}

const source = new DatabaseSync(fileURLToPath(new URL('devnet-acceptance-20261106.sqlite', output)), { readOnly: true });
let invoice, creation;
try {
  invoice = source.prepare(`SELECT o.id, o.mode, o.title, o.amount_units, o.recipient, o.reference, o.created_at,
    i.invoice_number, i.number_key, i.client, i.due_date, i.deposit_units
    FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.id=?`).get(run.invoice_id);
  creation = source.prepare("SELECT id, actor, timestamp, details FROM audit_events WHERE invoice_id=? AND kind='invoice_created'").get(run.invoice_id);
} finally {
  source.close();
}
if (!creation || invoice?.mode !== 'devnet' || invoice.reference !== run.invoice_reference || invoice.recipient !== run.receiver ||
    invoice.invoice_number !== run.invoice_number || invoice.amount_units !== 50_000_000 || invoice.deposit_units !== 30_000_000) {
  throw new Error('The saved invoice header does not match the recorded acceptance run.');
}

const rpc = createDevnetRpc(process.env.SOLANA_RPC_URL);
await rpc.ready();
const database = fileURLToPath(new URL(`hackathon-replay-${randomUUID()}.sqlite`, output));
openStore(database).close();
const target = new DatabaseSync(database);
try {
  target.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  target.prepare('INSERT INTO orders (id, mode, title, amount_units, recipient, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(invoice.id, invoice.mode, invoice.title, invoice.amount_units, invoice.recipient, invoice.reference, invoice.created_at);
  target.prepare('INSERT INTO invoices (order_id, mode, invoice_number, number_key, client, due_date, deposit_units) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(invoice.id, invoice.mode, invoice.invoice_number, invoice.number_key, invoice.client, invoice.due_date, invoice.deposit_units);
  target.prepare('INSERT INTO invoice_sync (invoice_id, financial_changed_at) VALUES (?, ?)').run(invoice.id, creation.timestamp);
  target.prepare("INSERT INTO audit_events (id, kind, invoice_id, actor, timestamp, details) VALUES (?, 'invoice_created', ?, ?, ?, ?)")
    .run(creation.id, invoice.id, creation.actor, creation.timestamp, creation.details);
  target.exec('COMMIT');
} finally {
  target.close();
}

const app = createApp({ database, merchant: invoice.recipient, rpc, seed: false, monitoring: false,
  walletReview: { invoiceId: invoice.id, url: walletOrigin, replay: true } });
const checkoutUrl = `${appOrigin}/pay/${invoice.id}`;
const wallet = createWalletHandoff({ store: app.services.store, invoiceId: invoice.id, payer: run.payer, rpc, checkoutUrl,
  origin: walletOrigin, replaySignatures: { direct: direct.signature, balance: balance.signature } });
try {
  const ready = Promise.all([once(app, 'listening'), once(wallet, 'listening')]);
  app.listen(4180, '127.0.0.1');
  wallet.listen(4181, '127.0.0.1');
  await ready;
  console.log(JSON.stringify({ kind: 'devnet_receipt_replay', workspace: `${appOrigin}/#invoices`, checkout: checkoutUrl, database }, null, 2));
} catch (error) {
  wallet.close();
  app.close();
  throw error;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => wallet.close(() => app.close()));
