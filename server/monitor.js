import { isSignature, RpcUnavailable } from './solana.js';
import { PaymentError } from './store.js';

export function createMonitor({store,payments,now=()=>Date.now(),budgetMs=10_000,maxEntries=Infinity,tickMs=1_000}) {
  const jobs=new Map();
  let stopped=false,timer=null;
  const iso=()=>new Date(now()).toISOString();
  const running=()=>!stopped&&!payments.stopped&&!store.closed;
  function nextAttempt(order,{unfinished=false,failures=0}={}) {
    if(order.mode==='demo') return null;
    if(failures) return new Date(now()+Math.min(60_000,10_000*2**Math.min(failures-1,3))).toISOString();
    if(unfinished || BigInt(store.view(order).invoice.remaining_units)>0n) return new Date(now()+10_000).toISOString();
    if(now()-Date.parse(store.sync(order.id).financial_changed_at)<86_400_000) return new Date(now()+60_000).toISOString();
    return null;
  }
  function check(order) {
    if(jobs.has(order.id)) return jobs.get(order.id);
    if(!running()) return Promise.reject(new RpcUnavailable('Invoice monitoring stopped.'));
    if(order.mode==='demo') return Promise.resolve({order:store.view(order),note:'Offline Demo state refreshed.'});
    if(jobs.size>=8) return Promise.reject(new PaymentError(429,'VERIFICATION_CAPACITY','Several invoices are catching up. Try again shortly.'));
    const task=scan(order).finally(()=>jobs.delete(order.id));
    jobs.set(order.id,task); return task;
  }
  async function scan(order) {
    const deadline=now()+budgetMs;
    const budget=AbortSignal.timeout(budgetMs);
    const waitForBudget=task=>new Promise((resolve,reject)=>{
      const expired=()=>reject(Object.assign(new Error('Scan budget exhausted'),{scanBudget:true}));
      if(budget.aborted){expired();return;}
      budget.addEventListener('abort',expired,{once:true});
      Promise.resolve(task).then(resolve,reject).finally(()=>budget.removeEventListener('abort',expired));
    });
    let processed=0;
    let job=store.sync(order.id);
    if(!job) throw new Error('Missing invoice monitoring state.');
    store.saveSync(order.id,{last_attempt:iso(),...(job.active_scan?{}:{active_scan:1,scan_head:null,cursor:null,pending_page:null})});
    try {
      while(running() && now()<deadline && processed<maxEntries) {
        job=store.sync(order.id);
        let page=job.pending_page;
        if(!page) {
          const history=await waitForBudget(payments.signatures(order.reference,{before:job.cursor??undefined,limit:50}));
          if(!running()) return;
          if(!Array.isArray(history)||history.length>50||history.some(e=>!isSignature(e?.signature)||!Object.hasOwn(e,'err')) ||
              new Set(history.map(e=>e.signature)).size!==history.length || history.some(e=>e.signature===job.cursor)) {
            throw new RpcUnavailable('The provider returned invalid or non-advancing signature history.');
          }
          const boundary=job.completed_watermark?history.findIndex(e=>e.signature===job.completed_watermark):-1;
          page={entries:history.slice(0,boundary<0?history.length:boundary).map(e=>({signature:e.signature,err:e.err,disposition:null})),
            boundary:boundary>=0,exhausted:history.length<50,last_signature:history.at(-1)?.signature??null};
          // Persist the full page and head before any transaction lookup.
          store.saveSync(order.id,{pending_page:page,...(!job.cursor?{scan_head:history[0]?.signature??job.scan_head}:{})});
        }
        let pending=false;
        for(let index=0;index<page.entries.length;index++) {
          if(!running() || now()>=deadline || processed>=maxEntries) break;
          const entry=page.entries[index];
          if(entry.disposition) continue;
          const result=entry.err!==null?{outcome:'ignored',signature:entry.signature}:await waitForBudget(payments.inspect(store.invoice(order.id),entry.signature,{history:true}));
          if(!running()) return;
          processed++;
          if(result.outcome==='pending') {pending=true;continue;}
          entry.disposition=result.outcome==='payment'?'verified':result.outcome;
          // Facts/cases and this entry's terminal disposition commit together.
          payments.commit(order,result,{progress:{pending_page:page}});
        }
        if(!running()) return;
        if(page.entries.some(e=>!e.disposition)) {
          store.saveSync(order.id,{next_attempt:nextAttempt(order,{unfinished:true}),failure_count:0,last_error:pending?'A transaction is not yet available at finalized commitment. Retrying without skipping it.':null});
          return {order:store.view(store.get(order.id)),note:'Catching up; the saved page will resume.'};
        }
        job=store.sync(order.id);
        if(page.boundary || page.exhausted) {
          if(job.completed_watermark && !page.boundary) {
            const failures=job.failure_count+1;
            store.saveSync(order.id,{active_scan:0,pending_page:null,cursor:null,scan_head:null,failure_count:failures,
              next_attempt:nextAttempt(order,{failures}),last_error:'History gap: the previous completed watermark was not found. The previous completion boundary is retained.'});
            return {order:store.view(store.get(order.id)),note:'History gap. A complete scan could not be confirmed.'};
          }
          store.saveSync(order.id,{completed_watermark:job.scan_head??job.completed_watermark,active_scan:0,pending_page:null,cursor:null,scan_head:null,
            last_complete:iso(),next_attempt:nextAttempt(order),failure_count:0,last_error:null});
          return {order:store.view(store.get(order.id)),note:'Checked finalized Devnet activity.'};
        }
        store.saveSync(order.id,{cursor:page.last_signature,pending_page:null});
      }
      if(running()) {
        store.saveSync(order.id,{next_attempt:nextAttempt(order,{unfinished:true}),last_error:null,failure_count:0});
        return {order:store.view(store.get(order.id)),note:'Catching up; the saved scan will resume.'};
      }
    } catch(error) {
      if(error.scanBudget&&running()) {
        store.saveSync(order.id,{next_attempt:nextAttempt(order,{unfinished:true}),last_error:null});
        return {order:store.view(store.get(order.id)),note:'Catching up; the scan budget ended and saved work will resume.'};
      }
      if(running()) {
        const failures=store.sync(order.id).failure_count+1;
        store.saveSync(order.id,{failure_count:failures,next_attempt:nextAttempt(order,{failures}),last_error:error.message});
      }
      throw error;
    }
  }
  async function tick() {
    if(!running()) return;
    const due=store.dueJobs(iso(),12).filter(order=>!jobs.has(order.id)).slice(0,Math.max(0,4-jobs.size));
    await Promise.allSettled(due.map(check));
  }
  return {check,tick,start(){if(timer||stopped)return;timer=setInterval(()=>void tick(),tickMs);timer.unref();void tick();},
    async stop(){stopped=true;clearInterval(timer);timer=null;await Promise.allSettled([...jobs.values()]);},get activeJobs(){return jobs.size;}};
}
