import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDevnetRpc, isAddress } from './solana.js';
import { createServer as createPortGuard } from 'node:net';
import { createWalletHandoff, walletHandoffUrl } from '../scripts/devnet-wallet.js';

const renderUrl = process.env.RENDER_EXTERNAL_URL;
const host = renderUrl ? '0.0.0.0' : '127.0.0.1';
const data = new URL('../data/', import.meta.url);
if (!renderUrl) mkdirSync(data, { recursive: true });
const port = Number(process.env.PORT || '4173');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const invoiceId = renderUrl ? undefined : process.env.RECORDING_INVOICE_ID?.trim();
const payer = renderUrl ? undefined : process.env.RECORDING_PAYER?.trim();
if ((invoiceId || payer) && (!invoiceId || !isAddress(payer))) {
  throw new Error('Set RECORDING_INVOICE_ID and the public RECORDING_PAYER together.');
}
const rpc = createDevnetRpc(renderUrl ? undefined : process.env.SOLANA_RPC_URL);
// Older releases have no database lock. Refuse to migrate while their normal port is in use.
const guard = createPortGuard();
await new Promise((resolve, reject) => {
  guard.once('error', reject);
  guard.listen(port, host, resolve);
});
const server = createApp({
  database: renderUrl ? ':memory:' : fileURLToPath(new URL('boothproof.sqlite', data)),
  merchant: renderUrl ? '' : process.env.MERCHANT_WALLET?.trim(),
  rpc,
  walletReview: invoiceId ? { invoiceId, url: walletHandoffUrl } : null,
  monitoring: !renderUrl,
  hostedDemoUrl: renderUrl
});
if(server.services.store.migration.backup) console.log(`Migration backup: ${server.services.store.migration.backup}`);
const wallet = invoiceId ? createWalletHandoff({
  store: server.services.store, invoiceId, payer, rpc, checkoutUrl: `http://127.0.0.1:${port}/pay/${invoiceId}`
}) : null;

guard.close(() => server.listen(port, host, () => {
  console.log('Boothproof listening at', renderUrl || `http://${host}:${port}`);
  if (wallet) wallet.listen(new URL(walletHandoffUrl).port, '127.0.0.1');
}));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  wallet?.close();
  server.close();
});
