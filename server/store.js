import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { newReference, paymentUrl, verifyPayment } from './solana.js';
import { DEMO_RECIPIENT, demoTransfer } from './fixtures.js';
import { InvoiceError, reconcileInvoice, calendarDate } from './invoices.js';
import { migrate } from './migrations.js';

export class PaymentError extends Error {
  constructor(status,code,message) { super(message); this.status=status; this.code=code; this.retryable=false; }
}
const conflict=(code,message)=>new PaymentError(409,code,message);
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parsed=row=>row?{...row,evidence:JSON.parse(row.evidence)}:null;

// A lock prevents concurrent local operators. Stop older, lock-free releases before upgrading.
function lockDatabase(file) {
  if(file===':memory:') return ()=>{};
  const path=file+'.lock';
  let fd;
  try { fd=openSync(path,'wx'); }
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    const pid=Number(readFileSync(path,'utf8'));
    if(!Number.isInteger(pid)||pid<=0) throw new Error(`Invalid database lock: ${path}. Stop the old application before removing this lock.`);
    try { process.kill(pid,0); }
    catch(probe) {
      if(probe.code==='ESRCH') { unlinkSync(path); return lockDatabase(file); }
      throw new Error('The database owner cannot be checked. Stop the old application before migrating.');
    }
    throw new Error(`Database already in use by process ${pid}. Stop the old application before startup or migration.`);
  }
  writeFileSync(fd,String(process.pid)); closeSync(fd);
  return ()=>unlinkSync(path);
}

export function openStore(file,{now=()=>Date.now(),migration={}}={}) {
  const unlock=lockDatabase(file);
  let db,closed=false;
  const iso=()=>new Date(now()).toISOString();
  try {
    db=new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;');
    const migrationResult=migrate(db,{file,now:iso(),...migration});
    db.exec('PRAGMA journal_mode=WAL;');
    return initialize(migrationResult);
  } catch(error) { db?.close(); unlock(); throw error; }

  function initialize(migrationResult) {
    const get=db.prepare('SELECT * FROM orders WHERE id=?');
    const metadata=db.prepare('SELECT invoice_number,client,due_date,deposit_units FROM invoices WHERE order_id=?');
    const rawInvoice=db.prepare('SELECT orders.*,invoices.invoice_number,invoices.client,invoices.due_date,invoices.deposit_units FROM orders JOIN invoices ON order_id=id WHERE id=?');
    const evidence=db.prepare('SELECT signature,kind,slot,amount,decimals,observed_at FROM evidence WHERE order_id=? ORDER BY slot,rowid');
    const payment=db.prepare('SELECT * FROM payments WHERE signature=?');
    const credits=db.prepare('SELECT * FROM payments WHERE allocated_order_id=? ORDER BY slot,signature');
    const cases=db.prepare('SELECT * FROM review_cases WHERE invoice_id=? ORDER BY created_at,id');
    const eventById=db.prepare('SELECT * FROM audit_events WHERE id=?');
    // Per-invoice append-only event counts are monotonic and reveal no other invoice activity.
    const projectionRevision=db.prepare('SELECT CAST(count(*) AS TEXT) revision FROM audit_events WHERE invoice_id=?');
    const financialRevision=db.prepare(`SELECT CAST(count(*) AS TEXT) revision FROM audit_events WHERE invoice_id=?
      AND kind IN ('invoice_created','legacy_allocation','reference_allocation','manual_allocation','allocation_reversed')`);
    const revision=id=>projectionRevision.get(id).revision;
    const financialRevisionOf=id=>financialRevision.get(id).revision;
    const insertEvidence=db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?) ON CONFLICT(signature) DO NOTHING');
    const insertPayment=db.prepare(`INSERT INTO payments
      (signature,mode,recipient,mint,amount_units,slot,chain_time,verified_at,provenance,source_owner,source_account,destination_account,instruction_index,
       bound_order_id,suggested_invoice_id,allocated_order_id,allocation_method,allocation_version,allocated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertEvent=db.prepare(`INSERT INTO audit_events
      (id,kind,payment_signature,invoice_id,case_id,resulting_version,actor,timestamp,request_fingerprint,details) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const ensureOpen=()=>{if(closed) throw new Error('The payment store is closed.');};
    function atomic(callback) {
      ensureOpen(); db.exec('BEGIN IMMEDIATE');
      try { const result=callback(); db.exec('COMMIT'); return result; }
      catch(error) { db.exec('ROLLBACK'); throw error; }
    }
    function audit(kind,{id=randomUUID(),signature=null,invoice_id=null,case_id=null,version=null,actor='system',request_fingerprint=null,details={}}={}) {
      insertEvent.run(id,kind,signature,invoice_id,case_id,version,actor,iso(),request_fingerprint,JSON.stringify(details));
    }
    function create({id,mode,title,amount,recipient,now:date=new Date(now())}) {
      ensureOpen();
      db.prepare(`INSERT INTO orders (id,mode,title,amount_units,recipient,reference,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(id,mode,title,amount,recipient,newReference(),date.toISOString());
      return get.get(id);
    }
    function createInvoices(rows,mode,recipient) {
      return atomic(()=>{
        const created=[],skipped=[];
        for(const row of rows) {
          const existing=db.prepare(`SELECT orders.*,invoices.* FROM orders JOIN invoices ON order_id=id WHERE invoices.mode=? AND number_key=?`).get(mode,row.number_key);
          if(existing) {
            if(existing.invoice_number!==row.invoice_number||existing.client!==row.client||existing.title!==row.title||existing.amount_units!==row.amount||
                existing.due_date!==row.due_date||existing.recipient!==recipient||existing.deposit_units!==(row.deposit_units??null)||(row.id&&row.id!==existing.id)) {
              throw new InvoiceError(`Invoice ${row.invoice_number} already exists with different details. No records were changed.`,409,'INVOICE_CONFLICT');
            }
            skipped.push(existing.id); continue;
          }
          const id=row.id??randomUUID();
          if(get.get(id)) throw conflict('REQUEST_ID_CONFLICT','This request ID is already in use.');
          create({id,mode,title:row.title,amount:row.amount,recipient});
          db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?,?)').run(id,mode,row.invoice_number,row.number_key,row.client,row.due_date,row.deposit_units??null);
          db.prepare('INSERT INTO invoice_sync (invoice_id,next_attempt,financial_changed_at) VALUES (?,?,?)').run(id,mode==='devnet'?iso():null,iso());
          audit('invoice_created',{invoice_id:id,actor:mode==='demo'?'demo':'local_operator',details:{expected_units:String(row.amount),deposit_units:row.deposit_units==null?null:String(row.deposit_units)}});
          created.push(id);
        }
        return {created,skipped};
      });
    }
    function sync(id) {
      const row=db.prepare('SELECT * FROM invoice_sync WHERE invoice_id=?').get(id);
      return row?{...row,pending_page:row.pending_page?JSON.parse(row.pending_page):null}:null;
    }
    const syncFields=new Set(['completed_watermark','active_scan','scan_head','cursor','pending_page','next_attempt','last_attempt','last_complete','failure_count','last_error','financial_changed_at']);
    function saveSync(id,patch) {
      ensureOpen();
      const keys=Object.keys(patch);
      if(!keys.length||keys.some(key=>!syncFields.has(key))) throw new Error('Invalid monitoring state update.');
      db.prepare(`UPDATE invoice_sync SET ${keys.map(key=>`${key}=?`).join(',')} WHERE invoice_id=?`).run(
        ...keys.map(key=>key==='pending_page'&&patch[key]!==null?JSON.stringify(patch[key]):patch[key]),id);
    }
    function monitoring(id) {
      const job=sync(id); if(!job) return null;
      return {last_attempt:job.last_attempt,last_complete:job.last_complete,catching_up:Boolean(job.active_scan),next_attempt:job.next_attempt,last_error:job.last_error,
        current:!job.active_scan&&!job.last_error&&Boolean(job.last_complete)&&now()-Date.parse(job.last_complete)<(job.next_attempt?75_000:60_000)};
    }
    function history(id) {
      return db.prepare(`SELECT audit_events.*,payments.amount_units,payments.source_owner,payments.recipient,payments.provenance,payments.allocation_method
        FROM audit_events LEFT JOIN payments ON payment_signature=signature WHERE invoice_id=? ORDER BY timestamp,audit_events.rowid`).all(id).map(e=>({...e,details:JSON.parse(e.details)}));
    }
    function view(order) {
      if(!order) return null;
      const entries=evidence.all(order.id),info=metadata.get(order.id);
      if(info) {
        const active=credits.all(order.id);
        const observations=active.map(p=>({...p,kind:'amount',amount:p.amount_units,decimals:6,observed_at:p.chain_time??p.verified_at}));
        const invoice=reconcileInvoice(info,order.amount_units,observations,calendarDate(new Date(now())));
        invoice.financial_revision=financialRevisionOf(order.id);
        const review_cases=cases.all(order.id).map(parsed);
        invoice.issues=review_cases.filter(c=>c.state==='open').length;
        const proof=observations.map(p=>({...p,kind:'credit'}));
        return {...order,revision:revision(order.id),code:order.id.slice(0,8).toUpperCase(),invoice,review_cases,recovery:recoveryState(order.id),timeline:history(order.id),receipt:invoice.state==='paid'?proof.at(-1):null,
          status:invoice.state==='paid'?'paid':invoice.issues?'review':'awaiting',evidence:[...proof,...entries.filter(e=>!['exact','amount'].includes(e.kind))].sort((a,b)=>a.slot-b.slot),payments:active,
          exceptions:invoice.issues,monitoring:monitoring(order.id),payment_url:order.mode==='devnet'&&BigInt(invoice.remaining_units)>0n?paymentUrl({...order,amount_units:invoice.remaining_units}):null};
      }
      const receipt=entries.find(e=>e.signature===order.accepted_signature)??null;
      const observations=entries.map(e=>({...e,kind:e.kind==='exact'&&e.signature!==order.accepted_signature?'duplicate':e.kind}));
      return {...order,revision:revision(order.id),code:order.id.slice(0,8).toUpperCase(),receipt,evidence:observations,status:receipt?'paid':entries.length?'review':'awaiting',
        exceptions:observations.filter(e=>e.kind!=='exact').length,payment_url:order.mode==='devnet'?paymentUrl(order):null};
    }
    function recoveryState(id) {
      const payments=db.prepare('SELECT signature,amount_units,verified_at FROM payments WHERE suggested_invoice_id=? AND allocated_order_id IS NULL').all(id);
      return {awaiting_allocation:payments.length,payments};
    }
    function checkout(id) {
      const order=get.get(id); if(!order) return null;
      const current=view(order);
      if(!current.invoice) { const {accepted_signature,...legacy}=current; return legacy; }
      const {invoice}=current;
      const safeProof=p=>({signature:p.signature,amount:p.amount_units,amount_units:p.amount_units,kind:'credit',decimals:6,slot:p.slot,
        observed_at:p.chain_time??p.verified_at,chain_time:p.chain_time,verified_at:p.verified_at,provenance:p.provenance});
      const verified=current.payments.map(safeProof);
      return {id:order.id,revision:current.revision,mode:order.mode,title:order.title,recipient:order.recipient,amount_units:order.amount_units,
        invoice:{invoice_number:invoice.invoice_number,client:invoice.client,due_date:invoice.due_date,state:invoice.state,expected_units:invoice.expected_units,
          received_units:invoice.received_units,remaining_units:invoice.remaining_units,excess_units:invoice.excess_units,overpaid_units:invoice.overpaid_units,
          deposit_units:invoice.deposit_units,deposit_remaining_units:invoice.deposit_remaining_units,credit_count:invoice.credit_count,overdue:invoice.overdue,financial_revision:invoice.financial_revision},
        receipt:invoice.state==='paid'?verified.at(-1):null,status:current.status==='review'?'awaiting':current.status,evidence:verified,payments:verified,
        recovery:current.recovery,monitoring:current.monitoring,payment_url:current.payment_url};
    }
    function observeException(id,result) {
      if(!metadata.get(id)) return;
      const key=`signature:${result.signature}`;
      if(db.prepare('SELECT 1 FROM review_cases WHERE invoice_id=? AND case_key=?').get(id,key)) return;
      const caseId=randomUUID();
      db.prepare(`INSERT INTO review_cases VALUES (?,?,?,?,?,?,'open',0,NULL,?,?)`).run(caseId,id,key,result.signature,result.code??result.kind,
        JSON.stringify({code:result.code,reason:result.reason,...(result.evidence?{observation:result.evidence}:{})}),iso(),iso());
      audit('exception_observed',{invoice_id:id,case_id:caseId,details:{signature:result.signature,reason:result.reason??result.kind}});
    }
    function refreshOverpayment(id) {
      if(!metadata.get(id)) return;
      const active=credits.all(id).sort((a,b)=>a.signature.localeCompare(b.signature));
      const received=active.reduce((sum,p)=>sum+BigInt(p.amount_units),0n);
      const excess=received>BigInt(get.get(id).amount_units)?received-BigInt(get.get(id).amount_units):0n;
      const previous=db.prepare("SELECT * FROM review_cases WHERE invoice_id=? AND case_key='overpayment'").get(id);
      const fp=JSON.stringify([excess.toString(),active.map(p=>[p.signature,p.allocation_version])]);
      if(excess===0n) {
        if(previous&&previous.state!=='cleared') {
          db.prepare("UPDATE review_cases SET state='cleared',version=version+1,updated_at=?,financial_fingerprint=? WHERE id=?").run(iso(),fp,previous.id);
          audit('review_cleared',{invoice_id:id,case_id:previous.id,version:previous.version+1,details:{note:'Allocation reversal removed the excess.'}});
        }
      } else if(!previous) {
        const caseId=randomUUID();
        db.prepare(`INSERT INTO review_cases VALUES (?,?,'overpayment',NULL,'overpayment',?,'open',0,?,?,?)`).run(caseId,id,JSON.stringify({excess_units:excess.toString()}),fp,iso(),iso());
        audit('overpayment_observed',{invoice_id:id,case_id:caseId,details:{excess_units:excess.toString()}});
      } else if(previous.financial_fingerprint!==fp||previous.state==='cleared') {
        db.prepare("UPDATE review_cases SET state='open',version=version+1,evidence=?,financial_fingerprint=?,updated_at=? WHERE id=?")
          .run(JSON.stringify({excess_units:excess.toString()}),fp,iso(),previous.id);
        audit('review_reopened',{invoice_id:id,case_id:previous.id,version:previous.version+1,details:{note:'Allocated payment evidence changed the excess.',excess_units:excess.toString()}});
      }
    }
    function financialChange(id) {
      if(!metadata.get(id)) return;
      saveSync(id,{financial_changed_at:iso(),next_attempt:get.get(id).mode==='devnet'?iso():null}); refreshOverpayment(id);
    }
    function ingest(order,result,{progress}={}) {
      return atomic(()=>{
        let saved=null;
        if(result.outcome==='payment') {
          const p=result.payment; saved=payment.get(p.signature);
          if(saved&&(saved.mode!==order.mode||saved.recipient!==order.recipient||(saved.bound_order_id&&saved.bound_order_id!==order.id)||
              (saved.allocated_order_id&&saved.allocated_order_id!==order.id))) throw conflict('REFERENCE_CONFLICT','This payment is reserved by another payment request.');
          if(saved&&!saved.allocated_order_id&&saved.suggested_invoice_id&&saved.suggested_invoice_id!==order.id) {
            throw conflict('RECOVERY_REPORT_CONFLICT','This unallocated payment was reported for a different invoice. Ask the merchant to inspect it in Recovery.');
          }
          if(!saved) {
            const bound=p.bound_order_id??null,suggested=metadata.get(order.id)?order.id:null;
            insertPayment.run(p.signature,p.mode,p.recipient,p.mint,p.amount_units,p.slot,p.chain_time,p.verified_at,p.provenance,p.source_owner,p.source_account,
              p.destination_account,p.instruction_index,bound,suggested,bound,bound?'reference':null,bound?1:0,bound?iso():null);
            audit('verified_transfer',{signature:p.signature,invoice_id:suggested??bound,actor:p.provenance==='demo'?'demo':'system',details:{amount_units:p.amount_units,provenance:p.provenance}});
            if(bound) {
              audit('reference_allocation',{signature:p.signature,invoice_id:bound,version:1,actor:p.provenance==='demo'?'demo':'system',details:{amount_units:p.amount_units,allocation_method:'reference'}});
              financialChange(bound);
            }
            saved=payment.get(p.signature);
          }
          // Shared reservation happens before the legacy booth can accept a receipt.
          if(result.evidence&&saved.bound_order_id===order.id) {
            const e=result.evidence,inserted=insertEvidence.run(e.signature,order.id,e.kind,e.slot,e.amount,e.decimals,e.observed_at);
            if(inserted.changes&&e.kind==='exact') db.prepare('UPDATE orders SET accepted_signature=? WHERE id=? AND accepted_signature IS NULL').run(e.signature,order.id);
          }
        } else if(result.outcome==='exception') {
          observeException(order.id,result);
          if(result.evidence) { const e=result.evidence; insertEvidence.run(e.signature,order.id,e.kind,e.slot,e.amount,e.decimals,e.observed_at); }
        }
        if(progress) saveSync(order.id,progress);
        return saved;
      });
    }
    function decisionResult(event,replayed) {
      return {replayed,payment:event.payment_signature?payment.get(event.payment_signature):null,order:event.invoice_id?view(get.get(event.invoice_id)):null,
        case:event.case_id?parsed(db.prepare('SELECT * FROM review_cases WHERE id=?').get(event.case_id)):null};
    }
    function decide(action,input) {
      const fp=fingerprint([action,input]);
      return atomic(()=>{
        const prior=eventById.get(input.request_id);
        if(prior) { if(prior.request_fingerprint!==fp) throw conflict('REQUEST_ID_CONFLICT','This request ID was used for a different decision.'); return decisionResult(prior,true); }
        if(action==='acknowledge'||action==='reopen') {
          const c=db.prepare('SELECT * FROM review_cases WHERE id=? AND invoice_id=?').get(input.case_id,input.invoice_id);
          if(!c) throw new PaymentError(404,'CASE_NOT_FOUND','This review case was not found.');
          if(c.version!==input.expected_version) throw conflict('STALE_VERSION','This review case changed. Refresh and make a new decision.');
          if(c.state==='cleared') throw conflict('CONDITION_CLEARED','This case is cleared because its financial condition no longer exists.');
          const state=action==='acknowledge'?'acknowledged':'open';
          if(c.state===state) throw conflict('INVALID_TRANSITION','The review case already has that state.');
          db.prepare('UPDATE review_cases SET state=?,version=version+1,updated_at=? WHERE id=?').run(state,iso(),c.id);
          audit(`review_${action}`,{id:input.request_id,invoice_id:input.invoice_id,case_id:c.id,version:c.version+1,actor:'local_operator',request_fingerprint:fp,details:{note:input.note,action,signature:c.signature}});
        } else {
          const p=payment.get(input.signature);
          if(!p) throw new PaymentError(404,'PAYMENT_NOT_FOUND','This verified payment was not found.');
          if(p.allocation_version!==input.expected_version) throw conflict('STALE_VERSION','This payment changed. Refresh and make a new decision.');
          let invoice_id=input.invoice_id;
          if(action==='allocate') {
            const target=rawInvoice.get(invoice_id);
            if(!target) throw new PaymentError(404,'INVOICE_NOT_FOUND','This invoice was not found.');
            if(p.allocated_order_id) throw conflict('ALREADY_ALLOCATED','This payment is already allocated.');
            if(p.bound_order_id) throw conflict('REFERENCE_BOUND','A reference-bound payment cannot be redirected.');
            if(p.mode!==target.mode||p.recipient!==target.recipient) throw conflict('INCOMPATIBLE_PAYMENT','Payment and invoice must use the same mode and receiving wallet.');
            if(typeof input.expected_invoice_revision!=='string'||!/^(0|[1-9]\d{0,19})$/.test(input.expected_invoice_revision)) {
              throw new PaymentError(400,'INVALID_INVOICE_REVISION','An expected invoice financial revision is required. Refresh the assignment preview.');
            }
            if(input.expected_invoice_revision!==financialRevisionOf(invoice_id)) {
              const error=conflict('STALE_INVOICE','The invoice balance changed after this preview. Refresh it and confirm again.');
              error.invoice=checkout(invoice_id);throw error;
            }
            db.prepare("UPDATE payments SET allocated_order_id=?,allocation_method='manual',allocation_version=allocation_version+1,allocated_at=? WHERE signature=?").run(invoice_id,iso(),p.signature);
          } else {
            if(!p.allocated_order_id||p.allocation_method!=='manual') throw conflict('REVERSAL_FORBIDDEN','Only a manual allocation can be reversed.');
            invoice_id=p.allocated_order_id;
            db.prepare('UPDATE payments SET allocated_order_id=NULL,allocation_method=NULL,allocation_version=allocation_version+1,allocated_at=NULL WHERE signature=?').run(p.signature);
          }
          audit(action==='allocate'?'manual_allocation':'allocation_reversed',{id:input.request_id,signature:p.signature,invoice_id,version:p.allocation_version+1,
            actor:'local_operator',request_fingerprint:fp,details:{note:input.note,amount_units:p.amount_units,allocation_method:'manual'}});
          financialChange(invoice_id);
        }
        return decisionResult(eventById.get(input.request_id),false);
      });
    }
    function paymentRequest(id,option) {
      const order=get.get(id),current=order?view(order):null;
      if(!current?.invoice) throw new PaymentError(404,'INVOICE_NOT_FOUND','This invoice was not found.');
      const amount=option==='deposit'?current.invoice.deposit_remaining_units:current.invoice.remaining_units;
      if(BigInt(amount)===0n) { const error=conflict('OPTION_UNAVAILABLE','This payment option is already satisfied. Refresh the invoice.'); error.invoice=checkout(id); throw error; }
      return {option,amount_units:amount,payment_url:order.mode==='devnet'?paymentUrl({...order,amount_units:amount}):null,invoice:checkout(id)};
    }
    function seedDemo() {
      if(!db.prepare("SELECT 1 FROM orders WHERE mode='demo' LIMIT 1").get()) {
        for(const [index,[title,amount,scenario]] of [['Iced coffee × 2',8_000_000,'exact'],['Sticker pack',3_500_000,'exact'],['Raffle ticket',5_000_000,'short'],['Bake sale box',6_500_000,null]].entries()) {
          const timestamp=now()-(24-index*5)*60_000;
          const order=create({id:randomUUID(),mode:'demo',title,amount,recipient:DEMO_RECIPIENT,now:new Date(timestamp)});
          if(scenario) { const s=demoTransfer(order,scenario,timestamp+60_000); ingest(order,verifyPayment(order,s.signature,s.transaction,{now:iso()})); }
        }
      }
      if(db.prepare("SELECT 1 FROM invoices WHERE mode='demo' LIMIT 1").get()) return;
      const today=calendarDate(new Date(now())),yesterday=calendarDate(new Date(now()-86_400_000));
      const rows=[['RECOVERY-050','Northstar Studio','Website design milestone',50_000_000,today,30_000_000],
        ['STUDIO-080','Juniper Collective','Brand illustration',80_000_000,today,null],['OVERDUE-125','Fieldwork Studio','Editorial layout',125_000_000,yesterday,null]];
      const ids=rows.map(([invoice_number,client,title,amount,due_date,deposit_units])=>createInvoices([{invoice_number,number_key:invoice_number,client,title,amount,due_date,deposit_units}], 'demo',DEMO_RECIPIENT).created[0]);
      for(const [index,scenario,amount] of [[1,'partial',20_000_000],[2,'wrong-token',125_000_000]]) {
        const order=rawInvoice.get(ids[index]),s=demoTransfer(order,scenario,now(),amount); ingest(order,verifyPayment(order,s.signature,s.transaction,{now:iso()}));
      }
    }
    return {create,createInvoices,view,checkout,ingest,decide,paymentRequest,seedDemo,sync,saveSync,migration:migrationResult,
      get:id=>get.get(id),invoice:id=>{const order=rawInvoice.get(id);return order?{...order,financial_revision:financialRevisionOf(id),revision:revision(id)}:undefined;},evidence:id=>evidence.all(id),payment:signature=>payment.get(signature),
      rejection:(id,signature)=>parsed(db.prepare('SELECT * FROM review_cases WHERE invoice_id=? AND signature=?').get(id,signature)),
      references:()=>new Map(db.prepare('SELECT reference,id FROM orders').all().map(row=>[row.reference,row.id])),
      list:mode=>db.prepare('SELECT * FROM orders WHERE mode=? AND id NOT IN (SELECT order_id FROM invoices) ORDER BY created_at DESC,rowid DESC').all(mode).map(view),
      invoices:mode=>db.prepare('SELECT orders.* FROM orders JOIN invoices ON order_id=id WHERE orders.mode=? ORDER BY created_at DESC,orders.rowid DESC').all(mode).map(view),
      payments:(mode,allocation='all')=>db.prepare(`SELECT * FROM payments WHERE mode=? ${allocation==='all'?'':allocation==='allocated'?'AND allocated_order_id IS NOT NULL':'AND allocated_order_id IS NULL'} ORDER BY verified_at DESC,signature`).all(mode),
      history,
      dueJobs:(timestamp,limit=4)=>db.prepare(`SELECT orders.* FROM invoice_sync JOIN orders ON invoice_id=id WHERE mode='devnet' AND next_attempt IS NOT NULL AND next_attempt<=?
        ORDER BY next_attempt,coalesce(last_attempt,''),invoice_id LIMIT ?`).all(timestamp,limit),
      close:()=>{if(!closed){closed=true;db.close();unlock();}},get closed(){return closed;}
    };
  }
}
