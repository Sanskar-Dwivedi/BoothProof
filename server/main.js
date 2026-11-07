import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDevnetRpc } from './solana.js';
import { createServer as createPortGuard } from 'node:net';

const data = new URL('../data/', import.meta.url);
mkdirSync(data, { recursive: true });
const port = Number(process.env.PORT || '4173');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
// Older releases have no database lock. Refuse to migrate while their normal port is in use.
const guard=createPortGuard();
await new Promise((resolve,reject)=>{guard.once('error',reject);guard.listen(port,'127.0.0.1',resolve);});
const server = createApp({
  database: fileURLToPath(new URL('boothproof.sqlite', data)),
  merchant: process.env.MERCHANT_WALLET?.trim(),
  rpc: createDevnetRpc(process.env.SOLANA_RPC_URL)
});
if(server.services.store.migration.backup) console.log(`Migration backup: ${server.services.store.migration.backup}`);

guard.close(()=>server.listen(port, '127.0.0.1', () => console.log(`Boothproof · http://127.0.0.1:${port}`)));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
