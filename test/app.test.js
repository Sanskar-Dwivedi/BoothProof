import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createDevnetRpc } from '../server/solana.js';
import { DEMO_RECIPIENT, demoTransfer } from '../server/fixtures.js';

async function start(options = {}) {
  const server = createApp({ seed: false, monitoring:false, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request: (path, data, headers = {}) => fetch(base + path, data === undefined ? { headers } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data)
    }),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

const orderPath = order => '/api/orders/' + order.id;
const newOrder = mode => ({ id: randomUUID(), title: 'Campus cookies', amount: '5.00', mode });
const json = async response => (await response.json()).order;

test('demo lifecycle survives restart, stays idempotent, and records exceptions without counting them as sales', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'boothproof-test-'));
  const database = join(directory, 'ledger.sqlite');
  let app = await start({ database });
  t.after(async () => {
    await app.close();
    for (const file of [database, database + '-wal', database + '-shm']) rmSync(file, { force: true });
    rmdirSync(directory);
  });
  const form = { ...newOrder('demo'), title: '=SUM(1,1)' };
  const created = await app.request('/api/orders', form);
  assert.equal(created.status, 201);
  let order = await json(created);
  assert.equal(order.status, 'awaiting');
  assert.equal(order.payment_url, null);
  assert.equal((await app.request('/api/orders', form)).status, 200);
  assert.equal((await app.request('/api/orders', { ...form, amount: '5.01' })).status, 409);

  const simulate = orderPath(order) + '/simulate';
  assert.equal((await app.request(simulate, { scenario: 'duplicate' })).status, 409);
  order = await json(await app.request(simulate, { scenario: 'short' }));
  assert.equal(order.status, 'review');
  assert.equal(order.receipt, null);
  assert.equal(order.evidence[0].kind, 'amount');
  order = await json(await app.request(simulate, { scenario: 'wrong-token' }));
  assert.equal(order.exceptions, 2);

  await Promise.all(Array.from({ length: 4 }, () => app.request(simulate, { scenario: 'exact' })));
  order = await json(await app.request(orderPath(order)));
  assert.equal(order.status, 'paid');
  assert.equal(order.evidence.filter(entry => entry.kind === 'exact').length, 1);
  const acceptedSignature = order.receipt.signature;
  order = await json(await app.request(simulate, { scenario: 'duplicate' }));
  assert.equal(order.receipt.signature, acceptedSignature);
  assert.equal(order.evidence.filter(entry => entry.kind === 'duplicate').length, 1);

  const csv = await (await app.request('/api/ledger.csv?mode=demo')).text();
  assert.match(csv, /"'=SUM\(1,1\)"/);
  assert.match(csv, /"paid","3"/);
  assert.deepEqual(await (await app.request('/api/orders?mode=devnet')).json(), { orders: [] });
  await app.close();
  app = await start({ database });
  order = await json(await app.request(orderPath(order)));
  assert.equal(order.receipt.signature, acceptedSignature);
  assert.equal(order.exceptions, 3);
});

test('Devnet verifies through JSON-RPC and recovers from provider failures without trusting demo input', async t => {
  const calls = [];
  const transfers = new Map();
  let available = false;
  let order;
  const transport = async (url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    calls.push(method);
    assert.equal(url.origin, 'https://api.devnet.solana.com');
    if (!available) return new Response(null, { status: 429 });
    let result;
    if (method === 'getGenesisHash') result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if (method === 'getSignaturesForAddress') {
      assert.equal(params[0], order.reference);
      assert.equal(params[1].commitment, 'finalized');
      result = [...transfers.keys()].reverse().map(signature => ({ signature, err: null }));
    } else if (method === 'getTransaction') {
      assert.equal(params[1].commitment, 'finalized');
      assert.equal(params[1].encoding, 'json');
      result = transfers.get(params[0]) ?? null;
    } else assert.fail(`unexpected RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id, result });
  };
  const app = await start({ merchant: DEMO_RECIPIENT, rpc: createDevnetRpc(undefined, transport) });
  t.after(() => app.close());
  order = await json(await app.request('/api/orders', newOrder('devnet')));
  assert.equal(order.status, 'awaiting');
  assert.ok(order.payment_url.startsWith('solana:'));
  assert.equal((await app.request(orderPath(order) + '/simulate', { scenario: 'exact' })).status, 409);
  const check = orderPath(order) + '/check';
  assert.equal((await app.request(check, {})).status, 503);
  assert.equal((await json(await app.request(orderPath(order)))).status, 'awaiting');

  available = true;
  for (const [index, scenario] of ['short', 'exact', 'duplicate'].entries()) {
    const transfer = demoTransfer(order, scenario, 1_799_999_900_000 + index * 1000);
    transfers.set(transfer.signature, transfer.transaction);
  }
  const results = await Promise.all([app.request(check, {}), app.request(check, {})]);
  for (const response of results) assert.equal(response.status, 200);
  order = await json(results[0]);
  assert.equal(order.status, 'paid');
  assert.deepEqual(order.evidence.map(entry => entry.kind), ['amount', 'exact', 'duplicate']);
  assert.equal(calls.filter(method => method === 'getSignaturesForAddress').length, 1);
  assert.equal(calls.filter(method => method === 'getTransaction').length, 3);
  const [signature] = transfers.keys();
  const duplicateLookup = await json(await app.request(check, { signature }));
  assert.equal(duplicateLookup.evidence.length, 3);
});

test('rejects a non-Devnet provider', async () => {
  const rpc = createDevnetRpc(undefined, async (_url, options) => Response.json({
    jsonrpc: '2.0', id: JSON.parse(options.body).id, result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  }));
  await assert.rejects(rpc.ready(), /does not report the Solana Devnet chain/);
});

test('serves the app and protects local routes from cross-site writes, unsafe payloads, and missing setup', async t => {
  const app = await start();
  t.after(() => app.close());
  const homepage = await app.request('/');
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /Boothproof/);
  assert.equal((await app.request('/styles.css')).status, 200);
  assert.equal((await app.request('/vendor/qrcode.mjs')).status, 200);
  const font = await app.request('/fonts/manrope-latin.woff2');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString('ascii'), 'wOF2');
  assert.equal((await app.request('/fonts/manrope-latin.woff2', undefined, { 'If-None-Match': font.headers.get('etag') })).status, 304);
  assert.equal((await app.request('/.env')).status, 404);
  assert.equal((await app.request('/api/orders', newOrder('demo'), { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await app.request('/api/orders', { ...newOrder('demo'), amount: '1e2' })).status, 400);
  assert.equal((await app.request('/api/orders', { ...newOrder('demo'), title: 'a'.repeat(5_000) })).status, 413);
  assert.equal((await app.request('/api/orders', newOrder('devnet'))).status, 409);
});

test('hosted checkout QR links open as top-level pages and still require demo credentials', async t => {
  const url = new URL('https://boothproof.example');
  const password = 'a'.repeat(48);
  const app = await start({ hostedDemo: { url, password } });
  t.after(() => app.close());

  const fromOutside = (path, headers = {}) => new Promise((resolve, reject) => {
    get(app.base + path, { headers: {
      Host: url.host,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      ...headers
    } }, response => {
      response.resume();
      resolve(response);
    }).on('error', reject);
  });

  const checkout = `/pay/${randomUUID()}`;
  const auth = { Authorization: `Basic ${Buffer.from(`judge:${password}`).toString('base64')}` };
  const challenge = await fromOutside(checkout);
  assert.equal(challenge.statusCode, 401);
  assert.match(challenge.headers['www-authenticate'], /^Basic /);

  const page = await fromOutside(checkout, auth);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal((await fromOutside(checkout, { ...auth, 'Sec-Fetch-Dest': 'iframe' })).statusCode, 403);
  assert.equal((await fromOutside('/api/config', auth)).statusCode, 403);
});

test('invoice API reconciles partial payments, rejects wrong tokens, and preserves booth totals', async t => {
  const app = await start({ merchant: DEMO_RECIPIENT });
  t.after(() => app.close());
  const form = {
    id: randomUUID(), mode: 'demo', invoice_number: 'INV-001', client: 'Northstar Studio',
    title: 'Website design', amount: '50.00', due_date: '2026-12-01'
  };
  const response = await app.request('/api/invoices', form);
  assert.equal(response.status, 201);
  let order = await json(response);
  assert.equal(order.invoice.state, 'unpaid');
  assert.equal((await app.request('/api/invoices', form)).status, 200);
  const simulate = scenario => app.request(orderPath(order) + '/simulate', { scenario });
  order = await json(await simulate('wrong-token'));
  assert.equal(order.invoice.received_units, '0');
  order = await json(await simulate('partial'));
  assert.equal(order.invoice.received_units, '30000000');
  assert.equal(order.invoice.remaining_units, '20000000');
  assert.equal(order.receipt, null);
  order = await json(await simulate('partial'));
  assert.equal(order.invoice.received_units, '30000000');
  order = await json(await simulate('remaining'));
  assert.equal(order.invoice.state, 'paid');
  assert.equal(order.invoice.credit_count, 2);
  assert.equal(order.receipt.signature, order.evidence.at(-1).signature);
  order = await json(await simulate('overpay'));
  assert.equal(order.invoice.state, 'overpaid');
  assert.equal(order.invoice.overpaid_units, '1000000');
  assert.equal(order.receipt, null);
  assert.equal(order.payment_url, null);
  assert.equal((await (await app.request('/api/orders?mode=demo')).json()).orders.length, 0);
  const csv = await (await app.request('/api/invoices.csv?mode=demo')).text();
  assert.match(csv, /"50.00","51.00","0.00","1.00","overpaid"/);
  assert.equal((await app.request('/api/invoices/import', { mode: 'devnet', csv: 'bad csv' })).status, 400);
});

test('CSV import is atomic and safe to retry, with distinct Demo and Devnet invoice numbers', async t => {
  const app = await start({ merchant: DEMO_RECIPIENT });
  t.after(() => app.close());
  const header = 'invoice_number,client,title,amount,due_date\n';
  const row = 'INV-001,Northstar Studio,Design,50.00,2026-12-01\n';
  const upload = (csv, mode = 'demo') => app.request('/api/invoices/import', { mode, csv });
  assert.deepEqual(await (await upload(header + row)).json(), { created: 1, skipped: 0 });
  assert.deepEqual(await (await upload(header + row)).json(), { created: 0, skipped: 1 });
  const newRow = 'INV-002,Northstar Studio,Copywriting,20.00,2026-12-01\n';
  const conflict = row.replace('50.00', '51.00');
  assert.equal((await upload(header + newRow + conflict)).status, 409);
  assert.equal((await (await app.request('/api/invoices?mode=demo')).json()).invoices.length, 1);
  assert.deepEqual(await (await upload(header + row, 'devnet')).json(), { created: 1, skipped: 0 });
  const { invoices: [order] } = await (await app.request('/api/invoices?mode=devnet')).json();
  assert.equal(order.invoice.remaining_units, '50000000');
  assert.equal(new URL(order.payment_url).searchParams.get('amount'), '50.00');
});

test('Devnet invoice verification accumulates actual finalized credits once and requests the precise remainder', async t => {
  const transactions = new Map();
  let transactionCalls = 0;
  const transport = async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    let result;
    if (method === 'getGenesisHash') result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    else if (method === 'getTransaction') {
      transactionCalls++;
      assert.equal(params[1].commitment, 'finalized');
      result = transactions.get(params[0]) ?? null;
    } else assert.fail(`unexpected RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id, result });
  };
  const app = await start({ merchant: DEMO_RECIPIENT, rpc: createDevnetRpc(undefined, transport) });
  t.after(() => app.close());
  let order = await json(await app.request('/api/invoices', {
    id: randomUUID(), mode: 'devnet', invoice_number: 'INV-RPC', client: 'Northstar Studio',
    title: 'Design milestone', amount: '50.00', due_date: '2026-12-01'
  }));
  const check = sample => app.request(orderPath(order) + '/check', { signature: sample.signature });
  const deposit = demoTransfer(order, 'deposit', 1_799_999_900_000, 30_000_000);
  transactions.set(deposit.signature, deposit.transaction);
  order = await json(await check(deposit));
  assert.equal(order.invoice.state, 'partial');
  assert.equal(order.invoice.received_units, '30000000');
  assert.equal(new URL(order.payment_url).searchParams.get('amount'), '20.00');
  const replay = await json(await check(deposit));
  assert.equal(replay.invoice.credit_count, 1);
  assert.equal(transactionCalls, 1);

  const nearly = demoTransfer(order, 'nearly', 1_799_999_901_000, 19_999_999);
  transactions.set(nearly.signature, nearly.transaction);
  order = await json(await check(nearly));
  assert.equal(order.invoice.received_units, '49999999');
  assert.equal(order.invoice.remaining_units, '1');
  assert.equal(new URL(order.payment_url).searchParams.get('amount'), '0.000001');

  const remainder = demoTransfer(order, 'remainder', 1_799_999_902_000, 1);
  transactions.set(remainder.signature, remainder.transaction);
  order = await json(await check(remainder));
  assert.equal(order.invoice.state, 'paid');
  assert.equal(order.invoice.credit_count, 3);
  assert.equal(order.payment_url, null);
  assert.equal(order.receipt.signature, remainder.signature);
  assert.equal((await app.request(orderPath(order) + '/simulate', { scenario: 'partial' })).status, 409);
});

test('invoice identity and partial-payment evidence survive a database restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'boothproof-invoice-test-'));
  const database = join(directory, 'ledger.sqlite');
  let app = await start({ database });
  t.after(async () => {
    await app.close();
    for (const file of [database, database + '-wal', database + '-shm']) rmSync(file, { force: true });
    rmdirSync(directory);
  });
  const form = {
    id: randomUUID(), mode: 'demo', invoice_number: 'INV-PERSIST', client: 'Northstar Studio',
    title: 'Maintenance', amount: '25.35', due_date: '2026-12-01'
  };
  let order = await json(await app.request('/api/invoices', form));
  const reference = order.reference;
  order = await json(await app.request(orderPath(order) + '/simulate', { scenario: 'partial' }));
  const signature = order.evidence[0].signature;
  await app.close();
  app = await start({ database });
  order = await json(await app.request(orderPath(order)));
  assert.equal(order.reference, reference);
  assert.equal(order.invoice.invoice_number, 'INV-PERSIST');
  assert.equal(order.invoice.client, 'Northstar Studio');
  assert.equal(order.invoice.state, 'partial');
  assert.equal(order.invoice.received_units, '15210000');
  assert.equal(order.invoice.remaining_units, '10140000');
  assert.equal(order.evidence[0].signature, signature);
  assert.equal((await app.request('/api/invoices', form)).status, 200);
  assert.equal((await (await app.request('/api/invoices?mode=demo')).json()).invoices.length, 1);
});
