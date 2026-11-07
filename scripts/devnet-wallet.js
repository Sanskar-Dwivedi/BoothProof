// Unsigned transaction preparation for the isolated two-wallet acceptance run.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { decodeBase58, formatUnits, isAddress, MINT, RpcUnavailable, TOKEN_PROGRAM } from '../server/solana.js';
import { PaymentError } from '../server/store.js';

export const walletHandoffUrl = 'http://127.0.0.1:4177';

function acceptancePayment(store, invoiceId, payer) {
  const saved = store.get(invoiceId);
  const order = saved && store.view(saved);
  const invoice = order?.invoice;
  if (order?.mode !== 'devnet' || invoice?.expected_units !== '50000000' || invoice.deposit_units !== '30000000' ||
      !isAddress(payer) || payer === order.recipient) {
    throw new PaymentError(409, 'ACCEPTANCE_INVOICE', 'This page requires the saved 50 USDC Devnet invoice and its separate payer.');
  }

  const payment = {
    invoice_id: invoiceId,
    invoice_number: invoice.invoice_number,
    payer,
    recipient: order.recipient,
    mint: MINT,
    financial_revision: invoice.financial_revision
  };
  if (invoice.remaining_units === '0') {
    return { ...payment, step: 'settled', amount_units: '0', reference: order.reference };
  }
  if (order.recovery.awaiting_allocation > 0) {
    return { ...payment, step: 'awaiting-assignment', amount_units: invoice.remaining_units, reference: null };
  }
  if (invoice.received_units === '0') {
    return { ...payment, step: 'direct', amount_units: '30000000', reference: null };
  }
  const [deposit] = order.payments;
  if (invoice.remaining_units === '20000000' && invoice.deposit_remaining_units === '0' && order.payments.length === 1 &&
      deposit.allocation_method === 'manual' && deposit.source_owner === payer && deposit.amount_units === '30000000') {
    const request = store.paymentRequest(invoiceId, 'balance');
    return { ...payment, step: 'balance', amount_units: request.amount_units, reference: order.reference };
  }
  throw new PaymentError(409, 'ACCEPTANCE_STEP', 'Open the customer statement to verify or assign the existing payment before preparing another.');
}

function legacyTransfer(payment, source, destination, blockhash) {
  // All lengths fit one compact-u16 byte. Static keys are writable signer, writable accounts, then read-only accounts.
  const addresses = [payment.payer, source, destination, MINT, TOKEN_PROGRAM];
  if (payment.reference) addresses.push(payment.reference);
  if (addresses.some(address => !isAddress(address)) || new Set(addresses).size !== addresses.length) {
    throw new PaymentError(409, 'ACCEPTANCE_ACCOUNTS', 'The payment accounts are invalid or overlap.');
  }
  const transferAccounts = [1, 3, 2, 0]; // TransferChecked: source, mint, destination, authority.
  if (payment.reference) transferAccounts.push(5); // Solana Pay reference on the final transfer.
  const transferData = Buffer.alloc(10);
  transferData[0] = 12;
  transferData.writeBigUInt64LE(BigInt(payment.amount_units), 1);
  transferData[9] = 6;
  const message = Buffer.concat([
    Buffer.from([1, 0, addresses.length - 3, addresses.length]),
    ...addresses.map(decodeBase58),
    decodeBase58(blockhash),
    Buffer.from([1, 4, transferAccounts.length, ...transferAccounts, transferData.length]),
    transferData
  ]);
  const transaction = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
  return { message, transaction };
}

function paymentForPreparation(store, invoiceId, payer) {
  const payment = acceptancePayment(store, invoiceId, payer);
  if (payment.step === 'settled' || payment.step === 'awaiting-assignment') {
    throw new PaymentError(409, 'ACCEPTANCE_STEP', payment.step === 'settled'
      ? 'This invoice is settled.' : 'The verified transfer awaits merchant assignment.');
  }
  return payment;
}

export async function prepareWalletTransfer({ store, invoiceId, payer, rpc }) {
  const payment = paymentForPreparation(store, invoiceId, payer);
  const payerWallet = await rpc.walletBalances(payer);
  const receiverWallet = await rpc.walletBalances(payment.recipient);
  const source = payerWallet.token_accounts.find(account =>
    account.state === 'initialized' && BigInt(account.amount_units) >= BigInt(payment.amount_units));
  const destination = receiverWallet.token_accounts.find(account => account.state === 'initialized');
  if (!source || !destination) {
    throw new PaymentError(409, 'ACCEPTANCE_FUNDING', 'Use existing initialized Devnet USDC accounts with enough USDC in one payer account.');
  }
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const unsigned = legacyTransfer(payment, source.address, destination.address, blockhash);
  const simulation = await rpc.simulateUnsigned(unsigned);
  const current = paymentForPreparation(store, invoiceId, payer);
  if (current.financial_revision !== payment.financial_revision || current.step !== payment.step ||
      current.amount_units !== payment.amount_units || current.reference !== payment.reference) {
    throw new PaymentError(409, 'STALE_INVOICE', 'The invoice changed during preparation. Refresh the payment preview.');
  }
  if (simulation.error !== null) {
    throw new PaymentError(422, 'ACCEPTANCE_SIMULATION', `Devnet simulation failed (${JSON.stringify(simulation.error)}).`);
  }
  if (BigInt(payerWallet.sol_lamports) < BigInt(simulation.fee_lamports)) {
    throw new PaymentError(409, 'ACCEPTANCE_FEE', 'The payer needs test SOL for the transaction fee.');
  }
  return {
    ...payment,
    chain: 'solana:devnet',
    transaction_version: 'legacy',
    amount: formatUnits(payment.amount_units),
    source_account: source.address,
    destination_account: destination.address,
    fee_lamports: simulation.fee_lamports,
    simulation_slot: simulation.simulation_slot,
    last_valid_block_height: lastValidBlockHeight,
    transaction: unsigned.transaction.toString('base64')
  };
}

export function createWalletHandoff(options) {
  const origin = new URL(options.origin ?? walletHandoffUrl);
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', './devnet-wallet.html']],
    ['/wallet.js', ['text/javascript; charset=utf-8', './devnet-wallet-browser.js']],
    ['/styles.css', ['text/css; charset=utf-8', '../public/styles.css']],
    ['/fonts/manrope-latin.woff2', ['font/woff2', '../public/fonts/manrope-latin.woff2']],
    ['/fonts/space-grotesk-latin.woff2', ['font/woff2', '../public/fonts/space-grotesk-latin.woff2']]
  ]);
  const { store, invoiceId, payer, checkoutUrl, replaySignatures } = options;
  let preparation;
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    if (request.headers.host !== origin.host || request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.headers.origin && request.headers.origin !== origin.origin)) {
      return json(403, { error: 'Open the local wallet review page from checkout.' });
    }
    if (request.method !== 'GET') return json(405, { error: 'Only read requests are supported.' });
    try {
      const asset = assets.get(request.url);
      if (asset) {
        const [contentType, path] = asset;
        const body = readFileSync(new URL(path, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(body);
      }
      if (request.url === '/api/payment') {
        const payment = acceptancePayment(store, invoiceId, payer);
        return json(200, { ...payment, checkoutUrl, ...(replaySignatures ? {
          replay: true, recorded_signature: replaySignatures[payment.step] ?? null
        } : {}) });
      }
      if (request.url === '/api/prepare') {
        if (replaySignatures) return json(409, { error: 'Use the finalized signature for this receipt replay.' });
        preparation ??= prepareWalletTransfer(options).finally(() => { preparation = undefined; });
        return json(200, await preparation);
      }
      return json(404, { error: 'Page not found.' });
    } catch (error) {
      const status = error instanceof PaymentError ? error.status : error instanceof RpcUnavailable ? 503 : 500;
      return json(status, { error: status === 500 ? 'Could not prepare this payment.' : error.message });
    }
  });
}
