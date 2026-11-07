import { verifyPayment, RpcUnavailable, UnsupportedTransaction } from './solana.js';
import { demoRecovery } from './fixtures.js';
import { PaymentError } from './store.js';

export function createPayments({store,rpc,now=()=>Date.now()}) {
  const controller=new AbortController(),rawTransactions=new Map(),completedTransactions=new Map(),verifications=new Map(),queue=[];
  let active=0,stopped=false;
  const ensureRunning=()=>{if(stopped) throw new RpcUnavailable('Payment checking stopped. Saved data is preserved.');};
  async function call(method,args) {
    ensureRunning();
    if(active>=4) {
      if(queue.length>=32) throw new PaymentError(429,'VERIFICATION_CAPACITY','Verification capacity is full. Try again shortly.');
      await new Promise((resolve,reject)=>queue.push({resolve,reject}));
    } else active++;
    try {
      ensureRunning();
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5_000)]);
      return await new Promise((resolve,reject)=>{
        const aborted=()=>reject(new RpcUnavailable('Solana Devnet checking was interrupted. Saved data is preserved.'));
        signal.addEventListener('abort',aborted,{once:true});
        Promise.resolve().then(()=>rpc[method](...args(signal))).then(resolve,reject)
          .finally(()=>signal.removeEventListener('abort',aborted));
      });
    } catch(error) {
      if(error instanceof PaymentError || error instanceof RpcUnavailable || error instanceof UnsupportedTransaction) throw error;
      throw new RpcUnavailable('Solana Devnet is unavailable. Saved data is preserved. Try again shortly.');
    } finally { const waiting=queue.shift(); if(waiting) waiting.resolve(); else active--; }
  }
  function transaction(signature) {
    const completed=completedTransactions.get(signature);
    if(completed&&now()-completed.at<5_000)return Promise.resolve(completed.raw);
    completedTransactions.delete(signature);
    if(rawTransactions.has(signature)) return rawTransactions.get(signature);
    const task=call('transaction',signal=>[signature,signal]).then(raw=>{
      if(raw!==null&&!stopped) {
        completedTransactions.set(signature,{raw,at:now()});
        if(completedTransactions.size>64)completedTransactions.delete(completedTransactions.keys().next().value);
      }
      return raw;
    }).finally(()=>rawTransactions.delete(signature));
    rawTransactions.set(signature,task); return task;
  }
  async function inspect(order,signature,{history=false}={}) {
    ensureRunning();
    const saved=store.payment(signature);
    if(saved) {
      if(saved.mode!==order.mode || saved.recipient!==order.recipient || (saved.bound_order_id&&saved.bound_order_id!==order.id) ||
          (saved.allocated_order_id&&saved.allocated_order_id!==order.id)) {
        return {outcome:'exception',signature,code:'REFERENCE_CONFLICT',reason:'This payment is reserved by another payment request.'};
      }
      if(!saved.allocated_order_id&&saved.suggested_invoice_id&&saved.suggested_invoice_id!==order.id) {
        return {outcome:'exception',signature,code:'RECOVERY_REPORT_CONFLICT',reason:'This unallocated payment was reported for a different invoice. Ask the merchant to inspect it in Recovery.'};
      }
      return {outcome:'payment',payment:saved};
    }
    const rejected=store.rejection(order.id,signature);
    const permanentlyExcluded=new Set(['WRONG_MINT','WRONG_RECIPIENT','BALANCE_MISMATCH','TRANSACTION_FAILED','ZERO_TRANSFER','SELF_TRANSFER','INVALID_REFERENCE','REFERENCE_CONFLICT','mint','recipient','balance']);
    if(rejected && permanentlyExcluded.has(rejected.reason)) {
      const codes={mint:'WRONG_MINT',recipient:'WRONG_RECIPIENT',balance:'BALANCE_MISMATCH'};
      return {outcome:'exception',signature,code:codes[rejected.reason]??rejected.reason,reason:rejected.evidence.reason??'This invalid transfer remains excluded from invoice credit.'};
    }
    let raw;
    if(order.mode==='demo') {
      const sample=demoRecovery(order,now());
      if(sample.signature!==signature) return {outcome:'exception',signature,code:'UNSUPPORTED_DEMO_SIGNATURE',reason:'Demo verification accepts only server-generated practice fixtures.'};
      raw=sample.transaction;
    } else {
      try{raw=await transaction(signature);}
      catch(error){if(error instanceof UnsupportedTransaction)return {outcome:'exception',signature,code:'UNSUPPORTED_TRANSACTION',reason:error.message};throw error;}
    }
    ensureRunning();
    const result=verifyPayment(order,signature,raw,{knownReferences:store.references(),now:new Date(now()).toISOString(),requireReference:!store.invoice(order.id)});
    // History may include an unrelated mention; it is never a payment or a recovery shortcut.
    if(history && result.code==='INVALID_REFERENCE') return {outcome:'ignored',signature};
    return result;
  }
  function commit(order,result,options) { ensureRunning(); return store.ingest(order,result,options); }
  function verify(order,signature) {
    const key=`${order.id}:${signature}`;
    if(verifications.has(key)) return verifications.get(key);
    if(verifications.size>=16) throw new PaymentError(429,'VERIFICATION_CAPACITY','Verification capacity is full. Try again shortly.');
    const task=(async()=>{
      const result=await inspect(order,signature);
      const saved=commit(order,result);
      if(result.outcome==='exception') throw new PaymentError(['REFERENCE_CONFLICT','RECOVERY_REPORT_CONFLICT'].includes(result.code)?409:422,result.code,result.reason);
      if(result.outcome==='pending') return {outcome:'pending',signature,invoice:store.checkout(order.id),note:'Not found at finalized commitment. Keep this signature and retry.'};
      return {outcome:saved.allocated_order_id?'allocated':'unallocated',signature,amount_units:saved.amount_units,invoice:store.checkout(order.id)};
    })().finally(()=>verifications.delete(key));
    verifications.set(key,task); return task;
  }
  return {inspect,commit,verify,
    signatures:(reference,options)=>call('signatures',signal=>[reference,signal,options]),
    async stop() {
      stopped=true; controller.abort();
      completedTransactions.clear();
      for(const item of queue.splice(0)) item.reject(new RpcUnavailable('Payment checking stopped.'));
      await Promise.allSettled([...verifications.values(),...rawTransactions.values()]);
    },get stopped(){return stopped;},get activeRpc(){return active;}
  };
}
