// Isolated offline browser rehearsal. Never opens the operator's saved database.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { DEMO_RECIPIENT } from '../server/fixtures.js';
const directory=new URL('../output/playwright/',import.meta.url);
mkdirSync(directory,{recursive:true});
const review = process.argv.includes('--review');
const server = createApp(review ? {
  database: ':memory:', merchant: DEMO_RECIPIENT, seed: false, monitoring: false,
  rpc: { transaction: async () => null, signatures: async () => [] }
} : { database: fileURLToPath(new URL('qa.sqlite', directory)) });
server.listen(4174,'127.0.0.1',()=>console.log('Offline browser rehearsal · http://127.0.0.1:4174'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
