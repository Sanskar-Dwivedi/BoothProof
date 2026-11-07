import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeBase58, encodeBase58, isAddress, isSignature, MINT, newReference, parseAmount, paymentUrl, verifyTransfer, createDevnetRpc, TOKEN_PROGRAM } from '../server/solana.js';
import { DEMO_RECIPIENT, demoTransfer } from '../server/fixtures.js';

function order() {
  return {
    id: randomUUID(), title: 'Coffee & cookies', amount_units: 5_000_000,
    reference: newReference(), recipient: DEMO_RECIPIENT
  };
}

test('uses integer token units and rejects ambiguous or out-of-range amounts', () => {
  assert.equal(parseAmount('0.01'), 10_000);
  assert.equal(parseAmount('5.2'), 5_200_000);
  assert.equal(parseAmount('9999.99'), 9_999_990_000);
  for (const input of ['0', '-3', '5e0', '1,00', '.1', '01', '1.000', '10000', ' 1', 5, null]) {
    assert.equal(parseAmount(input), null, String(input));
  }
});

test('base58 preserves leading zero bytes and checks address and signature lengths', () => {
  assert.equal(encodeBase58(Buffer.from([0, 0, 1, 2, 3])), '11Ldp');
  assert.deepEqual(decodeBase58('11Ldp'), Buffer.from([0, 0, 1, 2, 3]));
  assert.ok(isAddress(MINT));
  assert.ok(isAddress(newReference()));
  assert.equal(isAddress('0OIl'), false);
  assert.equal(isSignature(MINT), false);
  assert.ok(isSignature(demoTransfer(order(), 'exact').signature));
});

test('Solana Pay URL carries exact amount, Devnet mint and unique reference', () => {
  const request = order();
  const url = new URL(paymentUrl(request));
  assert.equal(url.protocol, 'solana:');
  assert.equal(url.pathname, request.recipient);
  assert.equal(url.searchParams.get('amount'), '5.00');
  assert.equal(url.searchParams.get('spl-token'), MINT);
  assert.equal(url.searchParams.get('reference'), request.reference);
  assert.equal(url.searchParams.get('message'), 'Coffee & cookies');
});

test('requires a successful transfer bound to the order and recognizes payment exceptions', () => {
  const request = order();
  for (const [scenario, kind] of [['exact', 'exact'], ['short', 'amount'], ['wrong-token', 'mint']]) {
    const { signature, transaction } = demoTransfer(request, scenario);
    assert.equal(verifyTransfer(request, signature, transaction)?.kind, kind);
  }
  const { signature, transaction } = demoTransfer(request, 'exact');
  assert.equal(verifyTransfer(order(), signature, transaction), null);
  assert.equal(verifyTransfer(request, demoTransfer(request, 'duplicate').signature, transaction), null);
  assert.equal(verifyTransfer({ ...request, recipient: newReference() }, signature, transaction)?.kind, 'recipient');
  transaction.meta.postTokenBalances[0].uiTokenAmount.amount = '3000000';
  assert.equal(verifyTransfer(request, signature, transaction)?.kind, 'balance');
  transaction.meta.err = { InstructionError: [0, 'InvalidArgument'] };
  assert.equal(verifyTransfer(request, signature, transaction), null);
});

test('a reference elsewhere in the message or a writable reference cannot settle', () => {
  const request = order();
  const { signature, transaction } = demoTransfer(request, 'exact');
  const message = transaction.transaction.message;
  const instruction = message.instructions[0];
  instruction.accounts.pop();
  assert.equal(verifyTransfer(request, signature, transaction), null);
  instruction.accounts.push(5);
  message.header.numReadonlyUnsignedAccounts = 0;
  assert.equal(verifyTransfer(request, signature, transaction), null);
});

test('accepts classic Transfer and correctly resolves v0 read-only lookup addresses', () => {
  const request = order();
  const { signature, transaction } = demoTransfer(request, 'exact');
  const message = transaction.transaction.message;
  message.accountKeys.pop();
  message.header.numReadonlyUnsignedAccounts = 2;
  transaction.meta.loadedAddresses = { readonly: [request.reference], writable: [] };
  assert.equal(verifyTransfer(request, signature, transaction)?.kind, 'exact');
  const instruction = message.instructions[0];
  const data = decodeBase58(instruction.data).subarray(0, 9);
  data[0] = 3;
  instruction.data = encodeBase58(data);
  instruction.accounts = [1, 2, 0, 5];
  assert.equal(verifyTransfer(request, signature, transaction)?.kind, 'exact');
});

test('public wallet preflight checks token ownership and sums exact spendable units without counting frozen funds',async()=>{
  const owner=newReference(),addresses=[newReference(),newReference()];let invalid=false;
  const rpc=createDevnetRpc(undefined,async(_url,options)=>{
    const {id,method,params}=JSON.parse(options.body);let result;
    if(method==='getGenesisHash')result='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if(method==='getBalance'){assert.equal(params[1].commitment,'finalized');result={value:10000000};}
    else if(method==='getAccountInfo')result={value:{owner:'11111111111111111111111111111111',executable:false}};
    else if(method==='getTokenAccountsByOwner') {
      assert.deepEqual(params[1],{mint:MINT});assert.equal(params[2].encoding,'jsonParsed');
      result={value:addresses.map((pubkey,index)=>({pubkey,account:{owner:invalid?'11111111111111111111111111111111':TOKEN_PROGRAM,
        data:{parsed:{type:'account',info:{mint:MINT,owner,state:index?'frozen':'initialized',tokenAmount:{amount:index?'30000000':'50000001',decimals:6}}}}}}))};
    } else if(method==='getMinimumBalanceForRentExemption'){assert.equal(params[0],165);result=1488440;}
    else assert.fail('Unexpected RPC '+method);
    return Response.json({jsonrpc:'2.0',id,result});
  });
  const balance=await rpc.walletBalances(owner);assert.equal(balance.sol_lamports,'10000000');assert.equal(balance.usdc_units,'80000001');
  assert.equal(balance.spendable_usdc_units,'50000001');assert.equal(await rpc.tokenAccountRent(),'1488440');
  invalid=true;await assert.rejects(rpc.walletBalances(owner),/ownership/);
});
