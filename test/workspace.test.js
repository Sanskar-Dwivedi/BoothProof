import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { demoTransfer,demoRecovery,DEMO_RECIPIENT } from '../server/fixtures.js';
import { decodeBase58, newReference } from '../server/solana.js';
import { prepareWalletTransfer } from '../scripts/devnet-wallet.js';

async function start(t, options = {}) {
  const transactions=new Map();
  const server=createApp({seed:false,monitoring:false,merchant:DEMO_RECIPIENT,rpc:{transaction:async signature=>transactions.get(signature)??null},...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(path,body)=>{
    const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const invoice=async(id=randomUUID())=> (await api('/api/invoices',{id,mode:'devnet',invoice_number:randomUUID().slice(0,8),
    client:'Review regression',title:'Design review',amount:'50.00',deposit_amount:'30.00',due_date:'2026-12-01'})).body.order;
  return {api,invoice,transactions,store:server.services.store,payments:server.services.payments};
}

test('allocation rejects a target invoice whose financial state changed after preview',async t=>{
  const s=await start(t),order=await s.invoice(),recovered=demoRecovery(order);
  s.transactions.set(recovered.signature,recovered.transaction);
  await s.api('/api/payments/verify',{invoice_id:order.id,signature:recovered.signature});
  const snapshot=(await s.api(`/api/orders/${order.id}`)).body.order;
  const p=s.store.payment(recovered.signature);
  const extra=demoTransfer(order,'another-payment',Date.now(),10_000_000);s.transactions.set(extra.signature,extra.transaction);
  await s.api('/api/payments/verify',{invoice_id:order.id,signature:extra.signature});
  const payload={request_id:randomUUID(),invoice_id:order.id,expected_version:p.allocation_version,
    expected_invoice_revision:snapshot.invoice.financial_revision,note:'Preview showed zero received'};
  const stale=await s.api(`/api/payments/${p.signature}/allocate`,payload);
  assert.equal(stale.status,409);assert.equal(stale.body.code,'STALE_INVOICE');
  assert.equal(s.store.view(s.store.get(order.id)).invoice.received_units,'10000000');
  const {expected_invoice_revision,...missingRevision}=payload;
  const missing=await s.api(`/api/payments/${p.signature}/allocate`,missingRevision);
  assert.equal(missing.status,400);assert.equal(missing.body.code,'INVALID_INVOICE_REVISION');
  const current=(await s.api(`/api/orders/${order.id}`)).body.order;
  const confirmed=await s.api(`/api/payments/${p.signature}/allocate`,{...payload,request_id:randomUUID(),expected_invoice_revision:current.invoice.financial_revision});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.order.invoice.received_units,'40000000');
});

test('checkout exposes a configured local wallet review only for its saved invoice', async t => {
  const invoiceId = randomUUID();
  const s = await start(t, { walletReview: { invoiceId, url: 'http://127.0.0.1:4177' } });
  await s.invoice(invoiceId);
  const other = await s.invoice();
  assert.deepEqual((await s.api(`/api/checkout/${invoiceId}`)).body.wallet_review, {
    url: 'http://127.0.0.1:4177/', replay: false
  });
  assert.equal((await s.api(`/api/checkout/${other.id}`)).body.wallet_review, undefined);
  assert.throws(() => createApp({ walletReview: { invoiceId, url: 'https://example.com/' } }), /loopback URL/);
});

test('projection revisions advance without turning review decisions into financial changes',async t=>{
  const s=await start(t),order=await s.invoice(),before=(await s.api(`/api/checkout/${order.id}`)).body.order;
  const sample=demoTransfer(order,'wrong-token');s.transactions.set(sample.signature,sample.transaction);
  await s.api('/api/payments/verify',{invoice_id:order.id,signature:sample.signature});
  const after=(await s.api(`/api/checkout/${order.id}`)).body.order;
  assert.ok(BigInt(after.revision)>BigInt(before.revision));assert.equal(after.invoice.financial_revision,before.invoice.financial_revision);
  assert.equal(after.invoice.received_units,'0');assert.equal(after.review_cases,undefined);
  const recovered=demoRecovery(order);s.transactions.set(recovered.signature,recovered.transaction);
  await s.api('/api/payments/verify',{invoice_id:order.id,signature:recovered.signature});
  const confirmed=await s.api(`/api/payments/${recovered.signature}/allocate`,{request_id:randomUUID(),invoice_id:order.id,expected_version:0,
    expected_invoice_revision:before.invoice.financial_revision,note:'Nonfinancial review did not invalidate the balance preview'});
  assert.equal(confirmed.status,200);assert.ok(BigInt(confirmed.body.order.invoice.financial_revision)>BigInt(before.invoice.financial_revision));
  const reverse=await s.api(`/api/payments/${recovered.signature}/unallocate`,{request_id:randomUUID(),expected_version:1,reason:'Check reversal revision'});
  assert.equal(reverse.body.order.invoice.received_units,'0');
  assert.ok(BigInt(reverse.body.order.invoice.financial_revision)>BigInt(confirmed.body.order.invoice.financial_revision));
});

test('concurrent first reports preserve exactly one invoice suggestion',async t=>{
  const s=await start(t),a=await s.invoice(),b=await s.invoice(),sample=demoRecovery(a);
  s.transactions.set(sample.signature,sample.transaction);
  const results=await Promise.all([s.api('/api/payments/verify',{invoice_id:a.id,signature:sample.signature}),
    s.api('/api/payments/verify',{invoice_id:b.id,signature:sample.signature})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const persisted=s.store.payment(sample.signature).suggested_invoice_id;
  const other=persisted===a.id?b.id:a.id;
  assert.equal((await s.api(`/api/checkout/${persisted}`)).body.order.recovery.awaiting_allocation,1);
  assert.equal((await s.api(`/api/checkout/${other}`)).body.order.recovery.awaiting_allocation,0);
});

test('an invoice returning to the same balance does not revive an old assignment preview',async t=>{
  const s=await start(t),order=await s.invoice(),first=demoRecovery(order),second=demoTransfer(order,'other-direct',Date.now(),10_000_000);
  const message=second.transaction.transaction.message;message.instructions[0].accounts.pop();message.accountKeys.pop();message.header.numReadonlyUnsignedAccounts--;
  for(const sample of [first,second]){s.transactions.set(sample.signature,sample.transaction);await s.api('/api/payments/verify',{invoice_id:order.id,signature:sample.signature});}
  const before=(await s.api(`/api/orders/${order.id}`)).body.order;
  const assigned=await s.api(`/api/payments/${second.signature}/allocate`,{request_id:randomUUID(),invoice_id:order.id,expected_version:0,expected_invoice_revision:before.invoice.financial_revision});
  assert.equal(assigned.status,200);
  await s.api(`/api/payments/${second.signature}/unallocate`,{request_id:randomUUID(),expected_version:1,reason:'Return to the original balance'});
  assert.equal(s.store.view(s.store.get(order.id)).invoice.received_units,'0');
  const stale=await s.api(`/api/payments/${first.signature}/allocate`,{request_id:randomUUID(),invoice_id:order.id,expected_version:0,expected_invoice_revision:before.invoice.financial_revision});
  assert.equal(stale.status,409);assert.equal(stale.body.code,'STALE_INVOICE');
});

test('an unallocated signature cannot promise a second invoice an unpersisted recovery report',async t=>{
  const s=await start(t),a=await s.invoice(),b=await s.invoice(),sample=demoRecovery(a);
  s.transactions.set(sample.signature,sample.transaction);
  assert.equal((await s.api('/api/payments/verify',{invoice_id:a.id,signature:sample.signature})).body.outcome,'unallocated');
  const other=await s.api('/api/payments/verify',{invoice_id:b.id,signature:sample.signature});
  assert.equal(other.status,409);assert.equal(other.body.code,'RECOVERY_REPORT_CONFLICT');
  assert.doesNotMatch(JSON.stringify(other.body),new RegExp(a.id));
  assert.equal((await s.api(`/api/checkout/${a.id}`)).body.order.recovery.awaiting_allocation,1);
  assert.equal((await s.api(`/api/checkout/${b.id}`)).body.order.recovery.awaiting_allocation,0);
});

test('legacy customer signature checks verify payment and return only the customer projection',async t=>{
  const s=await start(t);
  const order=(await s.api('/api/orders',{id:randomUUID(),mode:'devnet',title:'Legacy checkout',amount:'5.00'})).body.order;
  const sample=demoTransfer(order,'legacy-checkout');s.transactions.set(sample.signature,sample.transaction);
  const result=await s.api(`/api/checkout/${order.id}/check`,{signature:sample.signature});
  assert.equal(result.status,200);assert.equal(result.body.order.status,'paid');
  assert.equal(result.body.order.receipt.signature,sample.signature);
  assert.equal(result.body.order.accepted_signature,undefined);
  assert.equal((await s.api(`/api/checkout/${order.id}/check`,{signature:sample.signature,amount_units:'5000000'})).status,400);
});

test('Devnet wallet handoff simulates a reference-free deposit and binds only the allocated invoice remainder', async t => {
  const s = await start(t);
  const order = await s.invoice();
  const deposit = demoRecovery(order);
  const payer = deposit.transaction.meta.preTokenBalances.find(balance => balance.owner !== order.recipient).owner;
  const source = newReference(), destination = newReference(), blockhash = newReference();
  let simulationError = null;
  const rpc = {
    async walletBalances(owner) {
      return {
        sol_lamports: '10000000',
        token_accounts: [{ address: owner === payer ? source : destination, amount_units: '50000000', state: 'initialized' }]
      };
    },
    async latestBlockhash() { return { blockhash, lastValidBlockHeight: 20 }; },
    async simulateUnsigned({ message, transaction }) {
      assert.equal(transaction[0], 1);
      assert.deepEqual(transaction.subarray(1, 65), Buffer.alloc(64));
      assert.deepEqual(transaction.subarray(65), message);
      return { fee_lamports: 5000, simulation_slot: 10, error: simulationError };
    }
  };
  const options = { store: s.store, invoiceId: order.id, payer, rpc };
  simulationError = 'BlockhashNotFound';
  await assert.rejects(prepareWalletTransfer(options), { code: 'ACCEPTANCE_SIMULATION' });
  simulationError = null;

  const first = await prepareWalletTransfer(options);
  assert.equal(first.amount_units, '30000000');
  assert.equal(first.reference, null);
  assert.equal(first.chain, 'solana:devnet');
  const directMessage = Buffer.from(first.transaction, 'base64').subarray(65);
  assert.deepEqual([...directMessage.subarray(0, 4)], [1, 0, 2, 5]);
  assert.equal(directMessage.includes(decodeBase58(order.reference)), false);

  s.transactions.set(deposit.signature, deposit.transaction);
  const verified = await s.api('/api/payments/verify', { invoice_id: order.id, signature: deposit.signature });
  assert.equal(verified.body.outcome, 'unallocated');
  await assert.rejects(prepareWalletTransfer(options), { code: 'ACCEPTANCE_STEP' });
  const assigned = await s.api(`/api/payments/${deposit.signature}/allocate`, {
    request_id: randomUUID(), invoice_id: order.id, expected_version: 0,
    expected_invoice_revision: order.invoice.financial_revision
  });
  assert.equal(assigned.status, 200);

  const second = await prepareWalletTransfer(options);
  const checkout = await s.api(`/api/invoices/${order.id}/payment-request`, { option: 'balance' });
  assert.equal(second.amount_units, checkout.body.amount_units);
  assert.equal(second.reference, new URL(checkout.body.payment_url).searchParams.get('reference'));
  const balanceMessage = Buffer.from(second.transaction, 'base64').subarray(65);
  assert.deepEqual([...balanceMessage.subarray(0, 4)], [1, 0, 3, 6]);
  assert.deepEqual(balanceMessage.subarray(4 + 5 * 32, 4 + 6 * 32), decodeBase58(order.reference));
  assert.deepEqual([...balanceMessage.subarray(4 + 7 * 32, -10)], [1, 4, 5, 1, 3, 2, 0, 5, 10]);
  assert.equal(balanceMessage.readBigUInt64LE(balanceMessage.length - 9), 20_000_000n);

  const settlement = demoTransfer(order, 'acceptance balance', Date.now(), 20_000_000);
  s.transactions.set(settlement.signature, settlement.transaction);
  const settled = await s.api('/api/payments/verify', { invoice_id: order.id, signature: settlement.signature });
  assert.equal(settled.body.invoice.invoice.remaining_units, '0');
  await assert.rejects(prepareWalletTransfer(options), { code: 'ACCEPTANCE_STEP' });
});

test('wallet preparation rejects when a verified recovery arrives during simulation', async t => {
  const s = await start(t);
  const order = await s.invoice();
  const recovery = demoRecovery(order);
  const payer = recovery.transaction.meta.preTokenBalances.find(balance => balance.owner !== order.recipient).owner;
  const source = newReference(), destination = newReference(), blockhash = newReference();
  const simulating = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const rpc = {
    async walletBalances(owner) {
      return {
        sol_lamports: '10000000',
        token_accounts: [{ address: owner === payer ? source : destination, amount_units: '50000000', state: 'initialized' }]
      };
    },
    async latestBlockhash() { return { blockhash, lastValidBlockHeight: 20 }; },
    async simulateUnsigned() {
      simulating.resolve();
      await resume.promise;
      return { fee_lamports: 5000, simulation_slot: 10, error: null };
    }
  };

  const preparing = prepareWalletTransfer({ store: s.store, invoiceId: order.id, payer, rpc });
  try {
    await Promise.race([simulating.promise, preparing]);
    s.transactions.set(recovery.signature, recovery.transaction);
    const verified = await s.api('/api/payments/verify', { invoice_id: order.id, signature: recovery.signature });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.outcome, 'unallocated');
    assert.equal(verified.body.invoice.recovery.awaiting_allocation, 1);
    assert.equal(verified.body.invoice.invoice.financial_revision, order.invoice.financial_revision);
  } finally {
    resume.resolve();
  }
  await assert.rejects(preparing, { status: 409, code: 'ACCEPTANCE_STEP', message: /awaits merchant assignment/ });
});
