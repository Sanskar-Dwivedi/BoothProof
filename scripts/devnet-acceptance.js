// Public-address preflight and an isolated live acceptance instance. Never signs or sends funds.
import { mkdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createDevnetRpc,isAddress,isSignature,MINT,TOKEN_PROGRAM,paymentUrl,verifyPayment } from '../server/solana.js';
import { validateInvoice,calendarDate } from '../server/invoices.js';
import { createWalletHandoff,walletHandoffUrl } from './devnet-wallet.js';
import qrcode from '../public/vendor/qrcode.mjs';

const directory=new URL('../output/playwright/',import.meta.url);
mkdirSync(directory,{recursive:true});
const statePath=new URL('devnet-acceptance-20261106.json',directory);
const database=fileURLToPath(new URL('devnet-acceptance-20261106.sqlite',directory));
const base='http://127.0.0.1:4175';
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{kind:'real_devnet',transactions:{},live_acceptance:'pending'};
const args=process.argv.slice(2),action=args.shift()??'preflight';
function option(name) { const index=args.indexOf('--'+name);return index<0?undefined:args[index+1]; }
function save(){writeFileSync(statePath,JSON.stringify(state,null,2)+'\n');}
function receiver() {
  const address=process.env.MERCHANT_WALLET?.trim();
  if(!isAddress(address))throw new Error('Set MERCHANT_WALLET to the confirmed public receiving wallet in .env.');
  if(state.receiver&&state.receiver!==address)throw new Error('Receiver differs from this saved acceptance run. Preserve the existing run and inspect configuration.');
  state.receiver=address;return address;
}
const rpc=createDevnetRpc(process.env.SOLANA_RPC_URL);
async function json(path) {
  const response=await fetch(base+path,{signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error('The isolated acceptance instance is unavailable. Start its serve action.');
  return response.json();
}
function prepareQr(order) {
  const url=new URL(paymentUrl({...order,amount_units:'30000000'}));url.searchParams.delete('reference');
  state.direct_payment_url=url.href.replaceAll('+','%20');
  const qr=qrcode(0,'M');qr.addData(state.direct_payment_url,'Byte');qr.make();
  const font=readFileSync(new URL('../public/fonts/manrope-latin.woff2',import.meta.url)).toString('base64');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Real Devnet preparation · Boothproof</title>
  <style>@font-face{font-family:Manrope;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#080a0d;color:#f4f5f7;font:14px/1.65 Manrope,sans-serif}main{max-width:680px;margin:36px auto;padding:28px;border:1px solid #292e38;border-radius:12px;background:#101318}h1{font-size:28px;line-height:1.3}strong{color:#14f195}dl div{margin:14px 0}dt,p{color:#a1a8b5}dd{margin:3px 0;overflow-wrap:anywhere}.qr{background:white;color:black;width:270px;max-width:100%;padding:12px}.qr svg{display:block;width:100%;height:auto}.note{padding:12px;border:1px solid #f2c77950;border-radius:7px;color:#f2c779}a{color:#c8a5ff}@media(max-width:600px){main{margin:16px;padding:20px}}</style>
  <main><p>REAL DEVNET · TEST USDC · PREPARATION</p><h1>30 USDC without a reference</h1><p class="note">No transaction has been signed or sent by this page. Complete payer-wallet compatibility, funding and simulation checks first. The user reviews and signs in their own wallet.</p>
  <dl><div><dt>Recipient wallet</dt><dd>${order.recipient}</dd></div><div><dt>Token mint · standard SPL Token, six decimals</dt><dd>${MINT}</dd></div><div><dt>Amount / reference</dt><dd><strong>30.00 USDC</strong> · No reference</dd></div><div><dt>Network</dt><dd>Solana Devnet. Select Devnet in the payer wallet before scanning.</dd></div></dl><div class="qr">${qr.createSvgTag({cellSize:4,margin:12,scalable:true,alt:'Solana Pay request for 30 test USDC without a reference'})}</div>
  <p>This is the wallet payment QR, not a localhost browser link. Keep the customer checkout on this computer.</p><p>After signing, paste the actual signature into <a href="${base}/pay/${order.id}">I already paid</a>. The invoice must still show 50 USDC due until merchant assignment.</p></main></html>`;
  writeFileSync(new URL('devnet-direct-30-preparation.html',directory),html);
}

try {
  const merchant=receiver();
  if(action==='preflight') {
    const payer=option('payer')??state.payer??null;
    if(payer&&(!isAddress(payer)||payer===merchant))throw new Error('Provide a separate payer public wallet address.');
    const walletName=option('wallet'),walletVersion=option('wallet-version'),walletPlatform=option('wallet-platform');
    if(walletName||walletVersion||walletPlatform)state.wallet={name:walletName??state.wallet?.name??null,version:walletVersion??state.wallet?.version??null,
      platform:walletPlatform??state.wallet?.platform??null,compatibility:'unverified'};
    state.payer=payer;
    const slot=await rpc.slot(),mint=await rpc.mint(),receiverBalance=await rpc.walletBalances(merchant),rent=await rpc.tokenAccountRent();
    const payerBalance=payer?await rpc.walletBalances(payer):null;
    state.preflight={checked_at:new Date().toISOString(),cluster:'devnet',rpc_host:new URL(process.env.SOLANA_RPC_URL??'https://api.devnet.solana.com').hostname,
      finalized_slot:slot,mint,receiver:receiverBalance,payer:payerBalance,possible_token_account_rent_lamports:rent,
      payer_has_50_usdc:payerBalance?BigInt(payerBalance.spendable_usdc_units)>=50_000_000n:null,
      payer_covers_possible_account_rent:payerBalance?BigInt(payerBalance.sol_lamports)>BigInt(rent):null,
      wallet_format_verified:false,exact_fee_and_simulation_verified:false};
    state.pending=[...(!payer?['Provide a payer public address different from the receiver']:[]),
      ...(payerBalance&&BigInt(payerBalance.spendable_usdc_units)<50_000_000n?['Fund the payer with at least 50 canonical test USDC']:[]),
      ...(payerBalance&&BigInt(payerBalance.sol_lamports)<=BigInt(rent)?['Fund the payer with test SOL for fees and possible token-account creation']:[]),
      'Verify the wallet payment workflow and actual transaction format','Review actual wallet simulation and fees','User signs the reference-free 30 USDC request'];
    save();console.log(JSON.stringify({receiver:merchant,payer,preflight:state.preflight,pending:state.pending},null,2));
  } else if(action==='serve') {
    const invoiceId=state.invoice_id??randomUUID();
    const walletReview=state.payer?{invoiceId,url:walletHandoffUrl}:null;
    const server=createApp({database,merchant,seed:false,rpc,walletReview});
    let order=state.invoice_id?server.services.store.get(state.invoice_id):null;
    if(state.invoice_id&&!order) {
      server.close();throw new Error('The saved acceptance invoice is missing from its database. Inspect the saved run; do not replace its identity.');
    }
    if(!order) {
      const number='LIVE-20261106-'+randomUUID().slice(0,6);
      const due=new Date();due.setDate(due.getDate()+7);
      const invoice=validateInvoice({invoice_number:number,client:'Two-wallet Devnet acceptance',title:'USDC invoice recovery acceptance',amount:'50.00',deposit_amount:'30.00',due_date:calendarDate(due)});
      const result=server.services.store.createInvoices([{...invoice,id:invoiceId}],'devnet',merchant);
      order=server.services.store.get(result.created[0]);
    }
    state.invoice_id=order.id;state.invoice_number=server.services.store.view(order).invoice.invoice_number;
    state.invoice_reference=order.reference;state.database=database;state.checkout_url=base+'/pay/'+order.id;
    state.expected_units='50000000';state.deposit_units='30000000';prepareQr(order);save();
    const wallet=state.payer ? createWalletHandoff({store:server.services.store,invoiceId:order.id,payer:state.payer,rpc,checkoutUrl:state.checkout_url}) : null;
    wallet?.listen(4177,'127.0.0.1',()=>console.log(`Phantom Devnet handoff · ${walletHandoffUrl}`));
    server.listen(4175,'127.0.0.1',()=>console.log(JSON.stringify({kind:'real_devnet',local_workspace:base+'/#invoices',checkout:state.checkout_url,
      invoice:state.invoice_number,receiver:merchant,expected_units:state.expected_units,deposit_units:state.deposit_units,
      direct_30_qr:fileURLToPath(new URL('devnet-direct-30-preparation.html',directory)),signing:'User wallet only; payer preflight pending unless recorded separately.'},null,2)));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
      if(wallet) wallet.close(()=>server.close());
      else server.close();
    });
  } else if(action==='evidence') {
    const signature=option('signature');if(!isSignature(signature)||!state.invoice_id)throw new Error('Provide an actual public transaction signature and prepare the acceptance invoice first.');
    const raw=await rpc.transaction(signature);
    if(raw===null){console.log('Not found at finalized commitment. Existing evidence is preserved. Retry later.');process.exitCode=2;}
    else {
      const {order}=await json('/api/orders/'+state.invoice_id);
      const proof=verifyPayment({...order,invoice_number:order.invoice.invoice_number},signature,raw,{knownReferences:new Map([[order.reference,order.id]])});
      state.transactions[signature]={signature,explorer:`https://explorer.solana.com/tx/${signature}?cluster=devnet`,transaction_version:raw.version??null,
        fee_lamports:raw.meta?.fee??null,checked_at:new Date().toISOString(),outcome:proof.outcome,code:proof.code??null,payment:proof.payment??null};
      save();console.log(JSON.stringify(state.transactions[signature],null,2));
    }
  } else if(action==='snapshot') {
    if(!state.invoice_id)throw new Error('Prepare the isolated acceptance invoice first.');
    const {order}=await json('/api/orders/'+state.invoice_id),customer=await json('/api/checkout/'+state.invoice_id);
    const response=await fetch(base+'/api/invoices/'+state.invoice_id+'/history.csv');if(!response.ok)throw new Error('History export failed.');
    writeFileSync(new URL('devnet-acceptance-history.csv',directory),await response.text());
    writeFileSync(new URL('devnet-acceptance-statement.json',directory),JSON.stringify({kind:'real_devnet',captured_at:new Date().toISOString(),order:customer.order,history:order.timeline},null,2)+'\n');
    state.observed={received_units:order.invoice.received_units,remaining_units:order.invoice.remaining_units,deposit_remaining_units:order.invoice.deposit_remaining_units,
      allocated_signatures:order.payments.map(p=>p.signature),revision:order.revision};save();console.log(JSON.stringify(state.observed,null,2));
  } else throw new Error('Use preflight, serve, evidence --signature PUBLIC_SIGNATURE, or snapshot.');
} catch(error) {console.error(error.message);process.exitCode=1;}
