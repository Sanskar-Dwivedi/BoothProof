import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/store.js';
import { migrate } from '../server/migrations.js';
import { createPayments } from '../server/payments.js';
import { createMonitor } from '../server/monitor.js';
import { createApp } from '../server/app.js';
import { validateInvoice } from '../server/invoices.js';
import { demoTransfer, demoRecovery, DEMO_RECIPIENT } from '../server/fixtures.js';
import { verifyPayment, newReference, decodeBase58, encodeBase58, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, createDevnetRpc } from '../server/solana.js';

const fixedTime=Date.parse('2026-11-06T10:00:00Z');
function removeTestDirectory(directory) {
  const target=resolve(directory);
  assert.equal(dirname(target),resolve(tmpdir()));assert.match(basename(target),/^boothproof-/);
  rmSync(target,{recursive:true,force:true});
}
function invoice(store,{mode='devnet',amount='50.00',deposit_amount='30.00',recipient=DEMO_RECIPIENT,...rest}={}) {
  const row=validateInvoice({invoice_number:randomUUID().slice(0,8),client:'Test studio',title:'Design delivery',amount,deposit_amount,due_date:'2026-12-01',...rest});
  return store.invoice(store.createInvoices([row],mode,recipient).created[0]);
}
function setup(t,options={}) {
  const store=openStore(options.file??':memory:',{now:options.now??(()=>fixedTime)});
  const transactions=new Map(),histories=new Map(),calls=[];
  const rpc={
    async transaction(signature,signal) {calls.push(['transaction',signature]);return options.transaction?options.transaction(signature,signal):transactions.get(signature)??null;},
    async signatures(reference,signal,{before,limit}={}) {
      calls.push(['signatures',reference,before,limit]);
      const history=histories.get(reference)??[];
      const start=before?history.findIndex(s=>s.signature===before)+1:0;
      return history.slice(start,start+(limit??50));
    },...options.rpc
  };
  const payments=createPayments({store,rpc,now:options.now??(()=>fixedTime)});
  const monitor=createMonitor({store,payments,now:options.now??(()=>fixedTime),...options.monitor});
  t.after(async()=>{const a=monitor.stop(),b=payments.stop();await Promise.all([a,b]);store.close();});
  return {store,payments,monitor,transactions,histories,calls};
}
const allocation=(store,order,p,extra={})=>({request_id:randomUUID(),invoice_id:order.id,signature:p.signature,expected_version:p.allocation_version,
  expected_invoice_revision:store.invoice(order.id)?.financial_revision??'0',note:'Matched from client report',...extra});
function put(s,order,label,amount=1_000_000) {
  const sample=demoTransfer(order,label,fixedTime+s.transactions.size,amount);
  s.transactions.set(sample.signature,sample.transaction);return sample;
}

test('30 USDC recovery stays unallocated, approved allocation leaves 20, reference checkout settles, retries and reversal survive restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'boothproof-recovery-'));
  const file=join(directory,'ledger.sqlite');
  const s=setup(t,{file}),order=invoice(s.store);
  const sample=demoRecovery(order,fixedTime);s.transactions.set(sample.signature,sample.transaction);
  const verified=await s.payments.verify(order,sample.signature);
  assert.equal(verified.outcome,'unallocated');
  assert.equal(verified.invoice.invoice.received_units,'0');
  assert.equal(verified.invoice.recovery.awaiting_allocation,1);
  const p=s.store.payment(sample.signature),request=allocation(s.store,order,p);
  let result=s.store.decide('allocate',request);
  assert.equal(result.order.invoice.remaining_units,'20000000');
  assert.equal(result.order.invoice.deposit_remaining_units,'0');
  assert.throws(()=>s.store.paymentRequest(order.id,'deposit'),e=>e.code==='OPTION_UNAVAILABLE');
  const balance=s.store.paymentRequest(order.id,'balance');
  assert.equal(balance.amount_units,'20000000');
  assert.equal(new URL(balance.payment_url).searchParams.get('reference'),order.reference);
  const second=put(s,order,'balance',20_000_000);
  await Promise.all([s.payments.verify(order,second.signature),s.payments.verify(order,second.signature)]);
  assert.equal(s.store.view(order).invoice.received_units,'50000000');
  assert.equal(s.store.decide('allocate',request).replayed,true);
  assert.equal((await s.payments.verify(order,sample.signature)).outcome,'allocated');
  assert.equal(s.calls.filter(c=>c[0]==='transaction'&&c[1]===sample.signature).length,1);
  assert.throws(()=>s.store.decide('unallocate',{request_id:randomUUID(),signature:second.signature,expected_version:1,note:'Cannot undo reference'}),e=>e.code==='REVERSAL_FORBIDDEN');
  s.store.decide('unallocate',{request_id:randomUUID(),signature:p.signature,expected_version:1,note:'Client corrected the invoice assignment'});
  result=s.store.decide('allocate',request);
  assert.equal(result.replayed,true);
  assert.equal(result.payment.allocated_order_id,null);
  assert.equal(result.order.invoice.received_units,'20000000');
  await s.payments.stop();await s.monitor.stop();s.store.close();
  const restarted=openStore(file);t.after(()=>restarted.close());
  t.after(()=>removeTestDirectory(directory));
  assert.equal(restarted.view(restarted.get(order.id)).invoice.remaining_units,'30000000');
  assert.equal(restarted.payment(p.signature).amount_units,'30000000');
  assert.equal(restarted.history(order.id).filter(e=>e.kind==='allocation_reversed').length,1);
});

test('decisions reject changed request IDs, stale versions, racing allocations, incompatible mode/wallet and booth targets',async t=>{
  const s=setup(t),a=invoice(s.store),b=invoice(s.store),demo=invoice(s.store,{mode:'demo'}),different=invoice(s.store,{recipient:newReference()});
  const sample=demoRecovery(a,fixedTime);s.transactions.set(sample.signature,sample.transaction);await s.payments.verify(a,sample.signature);
  const p=s.store.payment(sample.signature);
  for(const target of [demo,different]) assert.throws(()=>s.store.decide('allocate',allocation(s.store,target,p)),e=>e.code==='INCOMPATIBLE_PAYMENT');
  const booth=s.store.create({id:randomUUID(),mode:'devnet',title:'Coffee',amount:30_000_000,recipient:DEMO_RECIPIENT});
  assert.throws(()=>s.store.decide('allocate',allocation(s.store,booth,p)),e=>e.code==='INVOICE_NOT_FOUND');
  const request=allocation(s.store,a,p);
  const race=await Promise.allSettled([Promise.resolve().then(()=>s.store.decide('allocate',request)),Promise.resolve().then(()=>s.store.decide('allocate',allocation(s.store,b,p)))]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.code,'STALE_VERSION');
  assert.throws(()=>s.store.decide('allocate',{...request,note:'Changed'}),e=>e.code==='REQUEST_ID_CONFLICT');
  await assert.rejects(s.payments.verify(b,p.signature),e=>e.code==='REFERENCE_CONFLICT');
  assert.equal(s.store.view(b).invoice.received_units,'0');
});

test('review acknowledgment leaves amounts unchanged, duplicate reports reuse cases, new excess reopens and reversal clears',async t=>{
  const s=setup(t),order=invoice(s.store),bad=put(s,order,'wrong-token',10_000_000);
  for(let i=0;i<2;i++) await assert.rejects(s.payments.verify(order,bad.signature),e=>e.code==='WRONG_MINT');
  assert.equal(s.store.view(order).review_cases.length,1);assert.equal(s.store.payment(bad.signature),undefined);
  let c=s.store.view(order).review_cases[0];
  const decision={request_id:randomUUID(),invoice_id:order.id,case_id:c.id,expected_version:c.version,note:'Wrong token excluded; contacted client'};
  s.store.decide('acknowledge',decision);assert.equal(s.store.view(order).invoice.received_units,'0');
  assert.equal(s.store.decide('acknowledge',decision).replayed,true);
  const exact=put(s,order,'full',50_000_000);await s.payments.verify(order,exact.signature);
  const recovered=demoRecovery(order,fixedTime);s.transactions.set(recovered.signature,recovered.transaction);await s.payments.verify(order,recovered.signature);
  const p=s.store.payment(recovered.signature);s.store.decide('allocate',allocation(s.store,order,p));
  c=s.store.view(order).review_cases.find(c=>c.reason==='overpayment');
  s.store.decide('acknowledge',{...decision,request_id:randomUUID(),case_id:c.id,expected_version:c.version,note:'Excess reviewed; no refund performed'});
  assert.equal(s.store.view(order).invoice.excess_units,'30000000');
  const more=put(s,order,'more',1);await s.payments.verify(order,more.signature);
  c=s.store.view(order).review_cases.find(c=>c.reason==='overpayment');assert.equal(c.state,'open');
  s.store.decide('unallocate',{request_id:randomUUID(),signature:p.signature,expected_version:1,note:'Remove mistaken assignment'});
  assert.equal(s.store.view(order).invoice.excess_units,'1');
  // A second invoice with a manual-only excess can clear entirely.
  const other=invoice(s.store,{amount:'20.00',deposit_amount:null});
  s.store.decide('allocate',allocation(s.store,other,s.store.payment(p.signature)));
  const before=s.store.view(other).review_cases.find(c=>c.reason==='overpayment');
  s.store.decide('unallocate',{request_id:randomUUID(),signature:p.signature,expected_version:3,note:'Wrong client confirmed'});
  const cleared=s.store.view(other).review_cases.find(c=>c.reason==='overpayment');assert.equal(cleared.state,'cleared');
  assert.throws(()=>s.store.decide('reopen',{...decision,request_id:randomUUID(),invoice_id:other.id,case_id:before.id,expected_version:cleared.version}),e=>e.code==='CONDITION_CLEARED');
});

test('full precision survives huge verified amounts and a one-base-unit deposit/balance remainder',async t=>{
  const s=setup(t),order=invoice(s.store),almost=put(s,order,'almost-deposit',29_999_999);
  await s.payments.verify(order,almost.signature);
  assert.equal(s.store.paymentRequest(order.id,'deposit').amount_units,'1');
  assert.equal(new URL(s.store.paymentRequest(order.id,'deposit').payment_url).searchParams.get('amount'),'0.000001');
  const large=put(s,order,'large','18446744073709551615');await s.payments.verify(order,large.signature);
  assert.equal(s.store.view(order).invoice.received_units,(18446744073709551615n+29_999_999n).toString());
  assert.equal(s.store.view(order).invoice.excess_units,(18446744073709551615n-20_000_001n).toString());
});

test('strict recovery verifier rejects invalid evidence and supports legacy/v0, Transfer and newly created destinations',async t=>{
  const s=setup(t),order=invoice(s.store);
  const valid=demoRecovery(order,fixedTime);
  assert.equal(verifyPayment(order,valid.signature,valid.transaction).outcome,'payment');
  const reject=(mutate,code)=>{
    const raw=structuredClone(valid.transaction);mutate(raw);
    const result=verifyPayment(order,valid.signature,raw);assert.equal(result.outcome,'exception');if(code)assert.equal(result.code,code);
  };
  reject(tx=>tx.meta.err={InstructionError:[0,'Error']},'TRANSACTION_FAILED');
  reject(tx=>delete tx.meta.postTokenBalances[0].owner,'UNSUPPORTED_TRANSACTION');
  reject(tx=>delete tx.meta.preTokenBalances[1].owner,'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.meta.postTokenBalances[0].owner=newReference(),'WRONG_RECIPIENT');
  reject(tx=>tx.meta.preTokenBalances[1].owner=order.recipient,'SELF_TRANSFER');
  reject(tx=>tx.meta.postTokenBalances[1].uiTokenAmount.amount='1','BALANCE_MISMATCH');
  reject(tx=>tx.meta.postTokenBalances[0].uiTokenAmount.amount='1','BALANCE_MISMATCH');
  reject(tx=>{const d=decodeBase58(tx.transaction.message.instructions[0].data);d.writeBigUInt64LE(0n,1);tx.transaction.message.instructions[0].data=encodeBase58(d);},'ZERO_TRANSFER');
  reject(tx=>tx.transaction.message.instructions.push(tx.transaction.message.instructions[0]),'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.transaction.message.instructions=[],'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.version=1,'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.slot=-1,'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.transaction.message.accountKeys[4]='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.transaction.message.instructions[0].accounts.push(0,0),'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.transaction.message.instructions[0].accounts[0]=999,'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.meta.innerInstructions={},'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.meta.innerInstructions=[{}],'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.meta.postTokenBalances.push(null),'UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.meta.postTokenBalances[0].uiTokenAmount.decimals='six','UNSUPPORTED_TRANSACTION');
  reject(tx=>tx.transaction.signatures={0:valid.signature,length:1},'UNSUPPORTED_TRANSACTION');
  reject(tx=>{tx.meta.innerInstructions=[{index:0,instructions:[structuredClone(tx.transaction.message.instructions[0])]}];},'UNSUPPORTED_TRANSACTION');
  reject(tx=>{tx.meta.preTokenBalances.shift();},'UNSUPPORTED_TRANSACTION');
  const v0=structuredClone(valid.transaction),message=v0.transaction.message;
  v0.version=0;message.accountKeys.pop();message.header.numReadonlyUnsignedAccounts=1;
  v0.meta.loadedAddresses={writable:[],readonly:[TOKEN_PROGRAM]};
  assert.equal(verifyPayment(order,valid.signature,v0).outcome,'payment');
  const transfer=message.instructions[0],plain=decodeBase58(transfer.data).subarray(0,9);plain[0]=3;
  transfer.data=encodeBase58(plain);transfer.accounts=[1,2,0];
  assert.equal(verifyPayment(order,valid.signature,v0).outcome,'payment');
  const created=structuredClone(valid.transaction);created.meta.preTokenBalances.shift();
  const cm=created.transaction.message;cm.accountKeys.push(ASSOCIATED_TOKEN_PROGRAM);cm.header.numReadonlyUnsignedAccounts=3;
  cm.instructions.unshift({programIdIndex:5,accounts:[0,2,0,3],data:''});
  assert.equal(verifyPayment(order,valid.signature,created).outcome,'payment');
  const loaded=structuredClone(valid.transaction),lm=loaded.transaction.message;
  const [payer,source,destination,mint,program]=lm.accountKeys;loaded.version=0;
  lm.accountKeys=[payer,mint,program];lm.header.numReadonlyUnsignedAccounts=2;
  lm.addressTableLookups=[{accountKey:newReference(),writableIndexes:[0,1],readonlyIndexes:[]}];
  loaded.meta.loadedAddresses={writable:[source,destination],readonly:[]};
  lm.instructions[0].programIdIndex=2;lm.instructions[0].accounts=[3,1,4,0];
  for(const group of [loaded.meta.preTokenBalances,loaded.meta.postTokenBalances])for(const balance of group)balance.accountIndex=balance.accountIndex===1?3:4;
  assert.equal(verifyPayment(order,valid.signature,loaded).outcome,'payment');
  const memo=structuredClone(valid.transaction),mm=memo.transaction.message;
  mm.accountKeys.push('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');mm.header.numReadonlyUnsignedAccounts++;
  mm.instructions.push({programIdIndex:5,accounts:[],data:encodeBase58(Buffer.from('client invoice note'))});
  assert.equal(verifyPayment(order,valid.signature,memo).outcome,'payment');
  const missingTime=structuredClone(valid.transaction);missingTime.blockTime=null;
  assert.equal(verifyPayment(order,valid.signature,missingTime).payment.chain_time,null);
});

test('a Phantom direct transfer repeating the signing authority stays unallocated', async t => {
  const s = setup(t), order = invoice(s.store);
  const { signature, transaction } = demoRecovery(order, fixedTime);
  const accounts = transaction.transaction.message.instructions[0].accounts;
  accounts.push(accounts[1]);
  assert.equal(verifyPayment(order, signature, transaction).reason, 'Unknown extra transfer accounts are unsupported.');
  accounts[4] = accounts[3];
  assert.equal(verifyPayment(order, signature, transaction, { requireReference: true }).code, 'INVALID_REFERENCE');
  s.transactions.set(signature, transaction);
  const result = await s.payments.verify(order, signature);
  assert.equal(result.outcome, 'unallocated');
  assert.equal(result.amount_units, '30000000');
  assert.equal(result.invoice.invoice.remaining_units, '50000000');
});

test('reference precedence prevents cross-invoice credit and malformed binding fallback; reference-free suggestions remain nonbinding',async t=>{
  const s=setup(t),a=invoice(s.store),b=invoice(s.store),sample=put(s,a,'reference',30_000_000);
  await assert.rejects(s.payments.verify(b,sample.signature),e=>e.code==='REFERENCE_CONFLICT');
  assert.equal(s.store.payment(sample.signature),undefined);
  for(const [label,mutate] of [
    ['account-list',tx=>tx.transaction.message.instructions[0].accounts.pop()],
    ['writable',tx=>tx.transaction.message.header.numReadonlyUnsignedAccounts=0],
    ['memo-after',tx=>{const m=tx.transaction.message;m.accountKeys.push('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');m.header.numReadonlyUnsignedAccounts++;m.instructions.push({programIdIndex:6,accounts:[],data:''});}]
  ]) {
    const bad=put(s,a,label);mutate(bad.transaction);
    await assert.rejects(s.payments.verify(a,bad.signature),e=>e.code==='INVALID_REFERENCE');
    assert.equal(s.store.payment(bad.signature),undefined);
  }
  const unbound=demoRecovery(a,fixedTime);s.transactions.set(unbound.signature,unbound.transaction);await s.payments.verify(a,unbound.signature);
  s.store.decide('allocate',allocation(s.store,b,s.store.payment(unbound.signature)));
  assert.equal(s.store.view(a).invoice.received_units,'0');assert.equal(s.store.view(b).invoice.received_units,'30000000');
});

for(const count of [21,51,123]) test(`monitor scans ${count} payments across exact 50-entry pages without stopping at known signatures`,async t=>{
  const s=setup(t),order=invoice(s.store,{amount:'100.00'}),samples=[];
  for(let i=0;i<count;i++) samples.push(put(s,order,`p${i}`,1));
  s.histories.set(order.reference,samples.map(p=>({signature:p.signature,err:null})).reverse());
  await s.payments.verify(order,samples[Math.floor(count/2)].signature);
  await s.monitor.check(order);
  assert.equal(s.store.view(order).invoice.received_units,String(count));
  assert.equal(s.store.sync(order.id).completed_watermark,samples.at(-1).signature);
  assert.ok(s.store.sync(order.id).last_complete);assert.equal(s.store.sync(order.id).active_scan,0);
  assert.equal(s.calls.filter(c=>c[0]==='signatures').length,Math.ceil(count/50));
});

test('monitor saves per-entry dispositions, resumes after restart, keeps temporary null pending, and finds new arrivals next scan',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'boothproof-monitor-'));
  const file=join(directory,'ledger.sqlite');
  let s=setup(t,{file,monitor:{maxEntries:7}}),order=invoice(s.store,{amount:'100.00'}),samples=[];
  for(let i=0;i<54;i++) samples.push(put(s,order,`scan${i}`,1));
  const history=samples.map(p=>({signature:p.signature,err:null})).reverse();s.histories.set(order.reference,history);
  const absent=samples.at(-2);s.transactions.delete(absent.signature);
  await s.monitor.check(order);
  assert.equal(s.store.sync(order.id).active_scan,1);assert.equal(s.store.sync(order.id).completed_watermark,null);
  assert.equal(s.store.sync(order.id).pending_page.entries.filter(e=>e.disposition).length,6);
  const transactions=s.transactions;
  await s.payments.stop();await s.monitor.stop();s.store.close();
  s=setup(t,{file});for(const [key,value] of transactions)s.transactions.set(key,value);s.histories.set(order.reference,history);
  await s.monitor.check(order);assert.equal(s.store.sync(order.id).completed_watermark,null);
  s.transactions.set(absent.signature,absent.transaction);
  const arrival=put(s,order,'arrival',1);s.histories.set(order.reference,[{signature:arrival.signature,err:null},...history]);
  await s.monitor.check(order);assert.equal(s.store.sync(order.id).completed_watermark,samples.at(-1).signature);
  assert.equal(s.store.view(order).invoice.received_units,'54');
  await s.monitor.check(order);assert.equal(s.store.view(order).invoice.received_units,'55');
  assert.equal(s.store.sync(order.id).completed_watermark,arrival.signature);
  t.after(()=>removeTestDirectory(directory));
});

test('RPC outage never advances history and backs off; a missing established watermark reports a history gap',async t=>{
  let timestamp=fixedTime,fail=false;
  const s=setup(t,{now:()=>timestamp,transaction:()=>{if(fail)throw new Error('offline');return raw;}}),order=invoice(s.store);
  const sample=put(s,order,'one',1),raw=sample.transaction;s.histories.set(order.reference,[{signature:sample.signature,err:null}]);
  fail=true;
  for(const delay of [10,20,40,60]) {
    await assert.rejects(s.monitor.check(order));const job=s.store.sync(order.id);
    assert.equal(job.completed_watermark,null);assert.equal(Date.parse(job.next_attempt)-timestamp,delay*1000);timestamp+=delay*1000;
  }
  fail=false;await s.monitor.check(order);const watermark=s.store.sync(order.id).completed_watermark;
  s.histories.set(order.reference,[]);await s.monitor.check(order);
  assert.equal(s.store.sync(order.id).completed_watermark,watermark);assert.match(s.store.sync(order.id).last_error,/History gap/);
});

test('monitor handles failed history entries, automatic operation without tabs, and clean shutdown during an uncooperative RPC',async t=>{
  let release,started;
  const began=new Promise(resolve=>started=resolve);
  const s=setup(t,{transaction:async()=>{started();return new Promise(resolve=>release=resolve);}}),order=invoice(s.store);
  const sample=put(s,order,'shutdown',1);s.histories.set(order.reference,[{signature:sample.signature,err:null}]);
  const scan=s.monitor.tick();await began;
  const a=s.monitor.stop(),b=s.payments.stop();await Promise.all([a,b,scan]);s.store.close();release(sample.transaction);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(s.store.closed,true);
  const automatic=setup(t),autoOrder=invoice(automatic.store),auto=put(automatic,autoOrder,'auto',1);
  automatic.histories.set(autoOrder.reference,[{signature:demoTransfer(autoOrder,'failed').signature,err:{InstructionError:[0,'Error']}},{signature:auto.signature,err:null}]);
  automatic.monitor.start();await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(automatic.store.view(autoOrder).invoice.received_units,'1');assert.ok(automatic.store.sync(autoOrder.id).last_complete);
});

test('all RPC access is bounded to four and overlapping signature fetches coalesce across callers',async t=>{
  let active=0,maximum=0,reads=0;
  const s=setup(t,{transaction:async signature=>{active++;reads++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;return s.transactions.get(signature);}});
  const order=invoice(s.store),samples=Array.from({length:12},(_,i)=>put(s,order,`capacity${i}`,1));
  await Promise.all(samples.flatMap(sample=>[s.payments.verify(order,sample.signature),s.payments.inspect(order,sample.signature)]));
  assert.equal(maximum,4);assert.equal(reads,12);assert.equal(s.store.view(order).invoice.received_units,'12');
});

test('verification and monitoring race through one raw fetch and one committed allocation',async t=>{
  const s=setup(t),order=invoice(s.store),sample=put(s,order,'racing',30_000_000);
  s.histories.set(order.reference,[{signature:sample.signature,err:null}]);
  await Promise.all([s.monitor.check(order),s.payments.verify(order,sample.signature)]);
  assert.equal(s.store.view(order).invoice.received_units,'30000000');
  assert.equal(s.store.history(order.id).filter(e=>e.kind==='reference_allocation').length,1);
  assert.equal(s.calls.filter(c=>c[0]==='transaction').length,1);
});

test('RPC unsupported-version errors produce terminal 422 exceptions instead of retryable outages',async t=>{
  let signature;
  const rpc=createDevnetRpc(undefined,async(_url,options)=>{
    const {id,method,params}=JSON.parse(options.body);
    if(method==='getGenesisHash')return Response.json({jsonrpc:'2.0',id,result:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'});
    if(method==='getTransaction') {
      assert.equal(params[1].maxSupportedTransactionVersion,0);
      return Response.json({jsonrpc:'2.0',id,error:{code:-32015,message:'Transaction version is not supported'}});
    }
    assert.equal(method,'getSignaturesForAddress');return Response.json({jsonrpc:'2.0',id,result:[{signature,err:null}]});
  });
  const s=setup(t,{rpc}),order=invoice(s.store);signature=demoTransfer(order,'unsupported-version').signature;
  await assert.rejects(s.payments.verify(order,signature),e=>e.status===422&&e.code==='UNSUPPORTED_TRANSACTION');
  assert.equal(s.store.payment(signature),undefined);
  await s.monitor.check(order);assert.equal(s.store.sync(order.id).completed_watermark,signature);
  assert.equal(s.store.sync(order.id).failure_count,0);assert.equal(s.store.view(order).review_cases.length,1);
});

test('monitor budgets preserve pending pages and scheduler windows remain fair and restartable',async t=>{
  let delayed=true,release;
  const s=setup(t,{monitor:{budgetMs:20},transaction:async signature=>delayed?await new Promise(resolve=>release=resolve):s.transactions.get(signature)});
  const order=invoice(s.store),sample=put(s,order,'budget',1);s.histories.set(order.reference,[{signature:sample.signature,err:null}]);
  await s.monitor.check(order);
  assert.equal(s.store.sync(order.id).active_scan,1);assert.equal(s.store.sync(order.id).completed_watermark,null);
  assert.equal(s.store.sync(order.id).pending_page.entries[0].disposition,null);
  delayed=false;release(sample.transaction);await new Promise(resolve=>setImmediate(resolve));
  await s.monitor.check(order);assert.equal(s.store.view(order).invoice.received_units,'1');
  let timestamp=fixedTime;
  const fair=setup(t,{now:()=>timestamp,monitor:{maxEntries:1}}),long=invoice(fair.store),small=invoice(fair.store);
  const many=Array.from({length:51},(_,i)=>put(fair,long,'fair'+i,1));fair.histories.set(long.reference,many.map(p=>({signature:p.signature,err:null})));
  const one=put(fair,small,'small',50_000_000);fair.histories.set(small.reference,[{signature:one.signature,err:null}]);
  await fair.monitor.tick();assert.ok(fair.store.sync(small.id).last_complete);assert.equal(fair.store.sync(long.id).active_scan,1);
  assert.equal(Date.parse(fair.store.sync(small.id).next_attempt)-timestamp,60_000);
  timestamp+=86_400_001;await fair.monitor.check(small);assert.equal(fair.store.sync(small.id).next_attempt,null);
  await fair.monitor.check(long);assert.equal(fair.store.sync(long.id).active_scan,1);assert.ok(fair.store.sync(long.id).next_attempt);
});

test('acknowledged invalid transfers remain excluded and newly created requests validate deposit boundaries',async t=>{
  const s=setup(t),order=invoice(s.store),sample=put(s,order,'wrong-token',30_000_000);
  await assert.rejects(s.payments.verify(order,sample.signature),e=>e.code==='WRONG_MINT');
  const c=s.store.view(order).review_cases[0];s.store.decide('acknowledge',{request_id:randomUUID(),invoice_id:order.id,case_id:c.id,expected_version:0,note:'Invalid token remains excluded'});
  // Even a subsequently inconsistent provider result cannot make an acknowledged invalid proof creditable.
  const changed=demoTransfer(order,'wrong-token',fixedTime,30_000_000),valid=demoTransfer(order,'valid',fixedTime,30_000_000);
  valid.transaction.transaction.signatures[0]=changed.signature;s.transactions.set(changed.signature,valid.transaction);
  await assert.rejects(s.payments.verify(order,changed.signature),e=>e.code==='WRONG_MINT');
  assert.equal(s.store.view(order).invoice.received_units,'0');
  for(const deposit_amount of ['0','50.00','60.00','1.001',30]) assert.throws(()=>validateInvoice({invoice_number:'D',client:'Client',title:'Title',amount:'50.00',due_date:'2026-12-01',deposit_amount}));
  for(const deposit_amount of [undefined,null,'']) assert.equal(validateInvoice({invoice_number:'D',client:'Client',title:'Title',amount:'50.00',due_date:'2026-12-01',deposit_amount}).deposit_units,null);
});

// Build an actual unversioned schema rather than using the new migration to manufacture a legacy DB.
function legacyDatabase(file) {
  const db=new DatabaseSync(file);db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;
    CREATE TABLE orders (id TEXT PRIMARY KEY,mode TEXT NOT NULL,title TEXT NOT NULL,amount_units INTEGER NOT NULL,recipient TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,accepted_signature TEXT) STRICT;
    CREATE TABLE invoices (order_id TEXT PRIMARY KEY REFERENCES orders(id),mode TEXT NOT NULL,invoice_number TEXT NOT NULL,number_key TEXT NOT NULL,client TEXT NOT NULL,due_date TEXT NOT NULL,UNIQUE(mode,number_key)) STRICT;
    CREATE TABLE evidence (signature TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,slot INTEGER NOT NULL,amount TEXT NOT NULL,decimals INTEGER NOT NULL,observed_at TEXT NOT NULL) STRICT;`);
  return db;
}
test('migration backs up committed WAL data, preserves invoice balances and booth receipts, excludes rejects, and repeats safely',t=>{
  const directory=mkdtempSync(join(tmpdir(),'boothproof-migration-'));
  const file=join(directory,'old.sqlite'),db=legacyDatabase(file);
  const id=randomUUID(),booth=randomUUID(),stamp=new Date(fixedTime).toISOString();
  const signature=demoTransfer({id,reference:newReference(),recipient:DEMO_RECIPIENT,amount_units:30_000_000},'old').signature;
  const boothSignature=demoTransfer({id:booth,reference:newReference(),recipient:DEMO_RECIPIENT,amount_units:5_000_000},'old').signature;
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)').run(id,'devnet','Old invoice',50_000_000,DEMO_RECIPIENT,newReference(),stamp,signature);
  db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?)').run(id,'devnet','OLD-1','OLD-1','Client','2026-12-01');
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)').run(booth,'demo','Booth',5_000_000,DEMO_RECIPIENT,newReference(),stamp,boothSignature);
  const insert=db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?)');
  insert.run(signature,id,'amount',1,'30000000',6,stamp);insert.run(boothSignature,booth,'exact',2,'5000000',6,stamp);
  insert.run('legacy-short',booth,'amount',4,'2500000',6,stamp);insert.run('legacy-additional',booth,'exact',5,'5000000',6,stamp);
  insert.run('rejected',id,'mint',3,'50000000',6,stamp);
  const result=migrate(db,{file,now:stamp});assert.ok(result.backup);assert.equal(readdirSync(join(directory,'backups')).length,1);
  const backup=new DatabaseSync(result.backup);assert.equal(backup.prepare('SELECT count(*) n FROM evidence').get().n,5);assert.equal(backup.prepare('PRAGMA user_version').get().user_version,0);backup.close();
  assert.equal(db.prepare('SELECT source_owner FROM payments WHERE signature=?').get(signature).source_owner,null);
  assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,4);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.equal(migrate(db,{file}).backup,null);db.close();
  const store=openStore(file);t.after(()=>store.close());
  t.after(()=>removeTestDirectory(directory));
  assert.equal(store.view(store.get(id)).invoice.received_units,'30000000');assert.equal(store.view(store.get(id)).invoice.remaining_units,'20000000');
  assert.equal(store.view(store.get(booth)).receipt.signature,boothSignature);assert.equal(store.payment(boothSignature).allocation_method,'legacy');
  assert.equal(store.payment('legacy-short').allocated_order_id,booth);assert.equal(store.payment('legacy-additional').allocated_order_id,booth);
  assert.equal(store.view(store.get(id)).review_cases.length,1);
  assert.throws(()=>store.decide('unallocate',{request_id:randomUUID(),signature:boothSignature,expected_version:1,note:'No'}),e=>e.code==='REVERSAL_FORBIDDEN');
});
test('migration aborts on backup failure, rolls back validation failure, rejects future schemas, and guards immutable facts/audit',t=>{
  const directory=mkdtempSync(join(tmpdir(),'boothproof-migration-failure-'));t.after(()=>removeTestDirectory(directory));
  const file=join(directory,'old.sqlite'),db=legacyDatabase(file);
  assert.throws(()=>migrate(db,{file,backup:()=>{throw new Error('disk full');}}),/backup failed/);
  assert.equal(db.prepare('PRAGMA table_info(invoices)').all().length,6);
  assert.throws(()=>migrate(db,{file,validateBackfill:()=>{throw new Error('injected mismatch');}}),/injected mismatch/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='payments'").get().n,0);
  db.exec('PRAGMA user_version=999');assert.throws(()=>migrate(db,{file}),/newer/);db.close();
  const fresh=new DatabaseSync(':memory:');migrate(fresh);fresh.prepare(`INSERT INTO orders VALUES ('x','demo','test',1000000,?,?,?,NULL)`).run(DEMO_RECIPIENT,newReference(),new Date(fixedTime).toISOString());
  fresh.prepare(`INSERT INTO audit_events (id,kind,actor,timestamp,details) VALUES ('event','test','system',?,'{}')`).run(new Date(fixedTime).toISOString());
  fresh.prepare(`INSERT INTO payments (signature,mode,recipient,mint,amount_units,slot,verified_at,provenance) VALUES ('proof','demo',?,?,'1000000',1,?,'demo')`).run(DEMO_RECIPIENT,newReference(),new Date(fixedTime).toISOString());
  assert.throws(()=>fresh.exec("UPDATE payments SET amount_units='2000000'"),/immutable/);assert.throws(()=>fresh.exec('DELETE FROM payments'),/preserved/);
  assert.throws(()=>fresh.exec("DELETE FROM audit_events"),/append-only/);assert.throws(()=>fresh.exec("UPDATE audit_events SET kind='changed'"),/append-only/);fresh.close();
});

test('HTTP contracts enforce strict inputs, customer privacy, isolated Demo, safe history export and pending 202',async t=>{
  const transactions=new Map();
  const server=createApp({seed:false,monitoring:false,merchant:DEMO_RECIPIENT,rpc:{transaction:async sig=>transactions.get(sig)??null}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,body)=>{const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:response.headers.get('content-type').includes('json')?await response.json():await response.text()};};
  const order=invoice(server.services.store);
  const absent=demoTransfer(order,'absent').signature;
  assert.equal((await request('/api/payments/verify',{invoice_id:order.id,signature:absent})).status,202);
  assert.equal((await request('/api/payments/verify',{invoice_id:order.id,signature:absent,amount_units:'50000000'})).body.code,'UNEXPECTED_FIELD');
  const demo=invoice(server.services.store,{mode:'demo'});
  assert.equal((await request('/api/payments/verify',{invoice_id:demo.id,signature:absent})).status,422);
  const sample=demoRecovery(order,fixedTime);transactions.set(sample.signature,sample.transaction);
  const verified=await request('/api/payments/verify',{invoice_id:order.id,signature:sample.signature});assert.equal(verified.body.outcome,'unallocated');
  const p=server.services.store.payment(sample.signature),decision=allocation(server.services.store,order,p,{note:'=HYPERLINK("bad") private operator note'});
  const {signature,...payload}=decision;
  assert.equal((await request(`/api/payments/${signature}/allocate`,payload)).status,200);
  const customer=await request(`/api/checkout/${order.id}`),serialized=JSON.stringify(customer.body);
  assert.doesNotMatch(serialized,/private operator note|review_cases|allocation_method|local_operator|request_id/);
  assert.equal(customer.body.order.invoice.remaining_units,'20000000');
  const history=await request(`/api/invoices/${order.id}/history.csv`);
  assert.match(history.body,/verified_transfer/);assert.match(history.body,/manual_allocation/);assert.match(history.body,/'=HYPERLINK/);
  assert.equal((await request(`/api/payments/${signature}/unallocate`,{request_id:randomUUID(),expected_version:1,reason:' '})).status,400);
  assert.equal((await request(`/api/checkout/${order.id}/check`,{signature})).body.code,'UNEXPECTED_FIELD');
  const other=invoice(server.services.store);
  const conflict=await request('/api/payments/verify',{invoice_id:other.id,signature});assert.equal(conflict.status,409);
  assert.doesNotMatch(JSON.stringify(conflict.body),new RegExp(order.id));
  const practice=await request(`/api/orders/${demo.id}/simulate`,{scenario:'recovery'});assert.equal(practice.body.outcome,'unallocated');
  const demoPayment=server.services.store.payment(practice.body.signature);
  server.services.store.decide('allocate',allocation(server.services.store,demo,demoPayment));
  const simulated=await request(`/api/checkout/${demo.id}/simulate`,{option:'balance'});
  assert.equal(simulated.status,200);assert.equal(simulated.body.order.invoice.received_units,'50000000');
  assert.equal(simulated.body.order.invoice.state,'paid');
  assert.equal((await request(`/api/checkout/${demo.id}/simulate`,{option:'balance'})).status,409);
});
