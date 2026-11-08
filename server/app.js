import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, PaymentError } from './store.js';
import { DEMO_RECIPIENT, demoScenarios, demoTransfer, demoRecovery } from './fixtures.js';
import { createDevnetRpc, formatUnits, isAddress, isSignature, parseAmount, RpcUnavailable, verifyPayment } from './solana.js';
import { InvoiceError, parseInvoiceCsv, validateInvoice } from './invoices.js';
import { createPayments } from './payments.js';
import { createMonitor } from './monitor.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isMode = value => value === 'demo' || value === 'devnet';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

class RequestError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fields(body,allowed) {
  if(Object.keys(body).some(key=>!allowed.includes(key))) throw new RequestError(400,'Unexpected request field. Payment facts are verified by the server.','UNEXPECTED_FIELD');
}
function decision(body,{noteRequired=false}={}) {
  if(!uuid.test(body.request_id)||!Number.isSafeInteger(body.expected_version)||body.expected_version<0) {
    throw new RequestError(400,'A UUID request_id and a nonnegative expected_version are required.');
  }
  const note=Object.hasOwn(body,'note')?body.note:Object.hasOwn(body,'reason')?body.reason:'';
  if(typeof note!=='string'||note.trim().length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)||(noteRequired&&!note.trim())) {
    throw new RequestError(400,'Enter a plain-text decision note of 1–500 characters.');
  }
  return {request_id:body.request_id,expected_version:body.expected_version,note:note.trim()};
}

function staticFiles() {
  const files = new Map();
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !MIME[extname(entry.name)]) continue;
    const path = resolve(entry.parentPath, entry.name);
    const key = '/' + path.slice(publicDir.length).replaceAll('\\', '/');
    const body = readFileSync(path);
    files.set(key, {
      body, type: MIME[extname(path)],
      tag: '"' + createHash('sha256').update(body).digest('hex').slice(0, 24) + '"'
    });
  }
  return files;
}

async function jsonBody(request, limit = 4_096) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, 'Send an application/json request.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new RequestError(413, 'This request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new RequestError(400, 'Enter valid JSON data.');
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function csvField(value) {
  const string = String(value ?? '');
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(string) ? "'" + string : string;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function ledgerCsv(orders) {
  const rows = [['Mode', 'Order', 'Item', 'Requested USDC', 'Status', 'Exceptions', 'Accepted signature', 'Created at', 'Settled at']];
  for (const order of orders) {
    rows.push([
      order.mode, order.code, order.title, formatUnits(order.amount_units),
      order.status, order.exceptions, order.receipt?.signature, order.created_at, order.receipt?.observed_at
    ]);
  }
  return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

function invoiceCsv(orders) {
  const rows = [['Invoice', 'Client', 'Description', 'Due date', 'Expected USDC', 'Received USDC', 'Outstanding USDC', 'Overpaid USDC', 'Status', 'Overdue', 'Review issues', 'Mode', 'Payment signatures', 'Deposit USDC', 'Deposit remaining USDC', 'Review states']];
  for (const order of orders) {
    const invoice = order.invoice;
    rows.push([
      invoice.invoice_number, invoice.client, order.title, invoice.due_date,
      formatUnits(order.amount_units), formatUnits(invoice.received_units), formatUnits(invoice.remaining_units),
      formatUnits(invoice.overpaid_units), invoice.state, invoice.overdue, invoice.issues, order.mode,
      order.evidence.filter(entry => entry.kind === 'credit').map(entry => entry.signature).join(' '),
      invoice.deposit_units===null?'':formatUnits(invoice.deposit_units),formatUnits(invoice.deposit_remaining_units),
      order.review_cases.map(c=>`${c.reason}: ${c.state}`).join('; ')
    ]);
  }
  return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export function createApp({ database = ':memory:', merchant = '', rpc = createDevnetRpc(), seed = true,
  monitoring = true, now = ()=>Date.now(), monitorOptions = {}, migration = {}, walletReview = null,
  hostedDemoUrl = null } = {}) {
  const demoUrl = hostedDemoUrl ? new URL(hostedDemoUrl) : null;
  if (demoUrl && demoUrl.protocol !== 'https:') {
    throw new Error('Hosted demo requires an HTTPS URL.');
  }
  if (merchant && (!isAddress(merchant) || merchant === '11111111111111111111111111111111')) {
    throw new Error('MERCHANT_WALLET must be a public Solana receiving wallet address.');
  }
  const reviewUrl = walletReview && new URL(walletReview.url);
  if (reviewUrl && (!uuid.test(walletReview.invoiceId) || reviewUrl.protocol !== 'http:' ||
      reviewUrl.hostname !== '127.0.0.1' || !reviewUrl.port || reviewUrl.pathname !== '/' ||
      reviewUrl.username || reviewUrl.password || reviewUrl.search || reviewUrl.hash)) {
    throw new Error('Wallet review requires a saved invoice ID and a loopback URL.');
  }
  const store = openStore(database,{now,migration});
  if (seed) store.seedDemo();
  const files = staticFiles();
  const activeChecks = new Map();
  const lastChecks = new Map();
  const payments = createPayments({store,rpc,now});
  const monitor = createMonitor({store,payments,now,...monitorOptions});
  let closing=false;

  function checkOrder(order, signature) {
    const key = signature ? `${order.id}:${signature}` : order.id;
    if (activeChecks.has(key)) return activeChecks.get(key);
    if(store.invoice(order.id) && !signature) return monitor.check(order);
    if(!signature && now()-(lastChecks.get(order.id)??-Infinity)<3_000) return Promise.resolve({order:store.view(store.get(order.id)),note:'Recently checked.'});
    if (activeChecks.size >= 4) {
      throw new RequestError(429, 'The booth is already checking several payments. Try again shortly.');
    }

    const task = (async () => {
      if(signature) {
        const result=await payments.verify(store.invoice(order.id)??order,signature);
        return {order:store.view(store.get(order.id)),note:result.note??'Verified finalized transfer.',outcome:result.outcome};
      }
      const known = new Set(store.evidence(order.id).map(entry => entry.signature));
      const history = await payments.signatures(order.reference,{limit:20});
      if(closing) return;
      const candidates = history.filter(entry => entry.err === null && isSignature(entry.signature) && !known.has(entry.signature));
      let matched = false;
      // Oldest first within the bounded lookback. Commit each small group before the next RPC round.
      candidates.reverse();
      for (let index = 0; index < candidates.length; index += 4) {
        const checked = await Promise.allSettled(candidates.slice(index, index + 4).map(entry=>payments.inspect(order,entry.signature)));
        if(closing) return;
        const observations = checked.filter(result => result.status === 'fulfilled' && result.value.outcome!=='pending').map(result => result.value);
        if (observations.length) {
          matched = true;
          for(const result of observations.sort((a,b)=>(a.payment?.slot??a.evidence?.slot??0)-(b.payment?.slot??b.evidence?.slot??0))) payments.commit(order,result);
        }
        const failure = checked.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
      let note = 'Checked finalized Devnet activity.';
      if(!signature) {
        lastChecks.set(order.id,now());
        if(lastChecks.size>500) lastChecks.delete(lastChecks.keys().next().value);
      }
      if (signature && !matched && !known.has(signature)) note = 'No matching finalized transfer for that signature yet.';
      if (!signature && history.length === 20) note = 'Checked the 20 most recent results. Older transfers can be checked by signature.';
      return { order: store.view(store.get(order.id)), note };
    })().finally(() => activeChecks.delete(key));
    activeChecks.set(key, task);
    return task;
  }

  async function handle(request, response) {
    const host = request.headers.host?.toLowerCase();
    const allowedHost = demoUrl ? host === demoUrl.host : /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host ?? '');
    if (!allowedHost) {
      throw new RequestError(403, demoUrl ? 'Use the Boothproof demo address.' : 'Use the local Boothproof address.');
    }

    const url = new URL(request.url, demoUrl ?? `http://${host}`);
    if (url.host !== host || (demoUrl && url.origin !== demoUrl.origin)) {
      throw new RequestError(400, 'Invalid request address.');
    }
    const path = url.pathname;
    const isAppPage = path === '/' || /^\/pay\/[0-9a-f-]+$/.test(path);
    const method = request.method;
    const origin = request.headers.origin;
    const demoNavigation = demoUrl && method === 'GET' && isAppPage &&
      request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if ((request.headers['sec-fetch-site'] === 'cross-site' && !demoNavigation) ||
        (origin && origin !== url.origin) || (demoUrl && method === 'POST' && origin !== url.origin)) {
      throw new RequestError(403, 'Requests must come from this Boothproof tab.');
    }

    if (method === 'GET' && path === '/api/config') {
      return sendJson(response, 200, { devnetConfigured: Boolean(merchant), ...(walletReview?.replay ? { devnetReceiptReplay: true } : {}) });
    }
    if(method==='GET' && path==='/api/payments') {
      const mode=url.searchParams.get('mode')??'demo',allocation=url.searchParams.get('allocation')??'all';
      if(!isMode(mode)||!['unallocated','allocated','all'].includes(allocation)) throw new RequestError(400,'Choose a valid mode and allocation filter.');
      return sendJson(response,200,{payments:store.payments(mode,allocation)});
    }
    if(method==='POST' && path==='/api/payments/verify') {
      const body=await jsonBody(request); fields(body,['invoice_id','signature']);
      if(!uuid.test(body.invoice_id)||!isSignature(body.signature)) throw new RequestError(400,'A valid invoice ID and Solana signature are required.');
      const order=store.invoice(body.invoice_id);
      if(!order) throw new RequestError(404,'This invoice was not found.','INVOICE_NOT_FOUND');
      const result=await payments.verify(order,body.signature);
      return sendJson(response,result.outcome==='pending'?202:200,result);
    }
    const allocationPath=/^\/api\/payments\/([^/]+)\/(allocate|unallocate)$/.exec(path);
    if(method==='POST' && allocationPath) {
      const [,signature,action]=allocationPath;
      if(!isSignature(signature)) throw new RequestError(400,'Invalid payment signature.');
      const body=await jsonBody(request);
      fields(body,action==='allocate'?['request_id','invoice_id','expected_version','expected_invoice_revision','note']:['request_id','expected_version','reason']);
      const input=decision(body,{noteRequired:action==='unallocate'});
      if(action==='allocate'&&!uuid.test(body.invoice_id)) throw new RequestError(400,'Choose an invoice.');
      return sendJson(response,200,store.decide(action,{...input,signature,...(action==='allocate'?{invoice_id:body.invoice_id,expected_invoice_revision:body.expected_invoice_revision}:{})}));
    }
    const invoicePath=/^\/api\/invoices\/([0-9a-f-]+)\/(payment-request|review-decisions|history\.csv)$/.exec(path);
    if(invoicePath&&uuid.test(invoicePath[1])) {
      const [,id,action]=invoicePath;
      if(!store.invoice(id)) throw new RequestError(404,'This invoice was not found.','INVOICE_NOT_FOUND');
      if(method==='POST'&&action==='payment-request') {
        const body=await jsonBody(request); fields(body,['option']);
        if(!['deposit','balance'].includes(body.option)) throw new RequestError(400,'Choose deposit or balance.');
        return sendJson(response,200,store.paymentRequest(id,body.option));
      }
      if(method==='POST'&&action==='review-decisions') {
        const body=await jsonBody(request); fields(body,['request_id','case_id','expected_version','action','note']);
        if(!uuid.test(body.case_id)||!['acknowledge','reopen'].includes(body.action)) throw new RequestError(400,'Choose a valid review case and action.');
        return sendJson(response,200,store.decide(body.action,{...decision(body,{noteRequired:true}),case_id:body.case_id,invoice_id:id}));
      }
      if(method==='GET'&&action==='history.csv') {
        const rows=[['Event time','Event type','Payment signature','Exact USDC','Source wallet','Recipient','Provenance','Allocation method','Actor','Decision note']];
        for(const e of store.history(id)) rows.push([e.timestamp,e.kind,e.payment_signature??e.details.signature,
          e.amount_units?formatUnits(e.amount_units):'',e.source_owner,e.recipient,e.provenance,
          e.details.allocation_method??(['reference_allocation','legacy_allocation'].includes(e.kind)?e.kind.split('_')[0]:''),e.actor,e.details.note??e.details.reason]);
        response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`attachment; filename="boothproof-history-${id}.csv"`});
        return response.end(rows.map(row=>row.map(csvField).join(',')).join('\r\n')+'\r\n');
      }
    }
    const customerPath=/^\/api\/checkout\/([0-9a-f-]+)(?:\/(check|simulate))?$/.exec(path);
    if(customerPath&&uuid.test(customerPath[1])) {
      const [,id,action]=customerPath,order=store.get(id);
      if(!order) throw new RequestError(404,'This checkout was not found.','INVOICE_NOT_FOUND');
      if(method==='GET'&&!action) {
        const checkout = store.checkout(id);
        const wallet = walletReview?.invoiceId === id && checkout.invoice && order.mode === 'devnet'
          ? { url: reviewUrl.href, replay: Boolean(walletReview.replay) } : undefined;
        return sendJson(response,200,{order:checkout,wallet_review:wallet});
      }
      if(method==='POST'&&action==='check') {
        const body=await jsonBody(request); fields(body,store.invoice(id)?[]:['signature']);
        const signature=Object.hasOwn(body,'signature')&&typeof body.signature==='string'?body.signature.trim():undefined;
        if(Object.hasOwn(body,'signature')&&!isSignature(signature))throw new RequestError(400,'Enter a valid Solana transaction signature.');
        const result=order.mode==='demo'&&!signature?{note:'Offline Demo state refreshed.'}:await checkOrder(order,signature);
        return sendJson(response,200,{order:store.checkout(id),note:result?.note,monitoring:store.checkout(id).monitoring});
      }
      if(method==='POST'&&action==='simulate') {
        const body=await jsonBody(request); fields(body,['option']);
        if(order.mode!=='demo') throw new RequestError(409,'Demo activity cannot settle Devnet invoices.','MODE_CONFLICT');
        if(!['deposit','balance'].includes(body.option)) throw new RequestError(400,'Choose deposit or balance.');
        const paymentRequest=store.invoice(id)?store.paymentRequest(id,body.option):{amount_units:String(order.amount_units)};
        const sample=demoTransfer(order,body.option==='balance'?'remaining':'deposit',now(),paymentRequest.amount_units);
        payments.commit(order,verifyPayment(order,sample.signature,sample.transaction,{knownReferences:store.references(),now:new Date(now()).toISOString()}));
        return sendJson(response,200,{order:store.checkout(id)});
      }
    }
    if (method === 'GET' && path === '/api/invoices/template.csv') {
      response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="boothproof-invoice-template.csv"'
      });
      return response.end('invoice_number,client,title,amount,due_date\r\nINV-001,Northstar Studio,Website design,50.00,2026-12-01\r\n');
    }
    if (method === 'GET' && (path === '/api/invoices' || path === '/api/invoices.csv')) {
      const mode = url.searchParams.get('mode') ?? 'demo';
      if (!isMode(mode)) throw new RequestError(400, 'Choose Demo or Devnet.');
      const invoices = store.invoices(mode);
      if (path.endsWith('.csv')) {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="boothproof-invoices-${mode}.csv"`
        });
        return response.end(invoiceCsv(invoices));
      }
      return sendJson(response, 200, { invoices });
    }
    if (method === 'POST' && (path === '/api/invoices' || path === '/api/invoices/import')) {
      const importing = path.endsWith('/import');
      const body = await jsonBody(request, importing ? 65_536 : 4_096);
      fields(body,importing?['mode','csv']:['id','mode','invoice_number','client','title','amount','due_date','deposit_amount']);
      if (!isMode(body.mode)) throw new RequestError(400, 'Choose Demo or Devnet.');
      const recipient = body.mode === 'demo' ? DEMO_RECIPIENT : merchant;
      if (!recipient) throw new RequestError(409, 'Set MERCHANT_WALLET in .env and restart to create Devnet invoices.');
      if (!importing && !uuid.test(body.id)) throw new RequestError(400, 'A valid request ID is required.');
      const rows = importing ? parseInvoiceCsv(body.csv) : [{ ...validateInvoice(body), id: body.id }];
      const result = store.createInvoices(rows, body.mode, recipient);
      if (importing) return sendJson(response, 200, { created: result.created.length, skipped: result.skipped.length });
      const order = store.get(result.created[0] ?? result.skipped[0]);
      return sendJson(response, result.created.length ? 201 : 200, { order: store.view(order) });
    }
    if (method === 'GET' && (path === '/api/orders' || path === '/api/ledger.csv')) {
      const mode = url.searchParams.get('mode') ?? 'demo';
      if (!isMode(mode)) throw new RequestError(400, 'Choose Demo or Devnet.');
      const orders = store.list(mode);
      if (path.endsWith('.csv')) {
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="boothproof-${mode}.csv"`
        });
        return response.end(ledgerCsv(orders));
      }
      return sendJson(response, 200, { orders });
    }
    if (method === 'POST' && path === '/api/orders') {
      const body = await jsonBody(request);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const amount = parseAmount(body.amount);
      if (!uuid.test(body.id) || !isMode(body.mode) || !title || title.length > 60 ||
          /[\u0000-\u001f\u007f]/u.test(title) || amount === null) {
        throw new RequestError(400, 'Enter an item name and an amount from 0.01 to 9,999.99 USDC.');
      }
      const prior = store.get(body.id);
      const recipient = body.mode === 'demo' ? DEMO_RECIPIENT : merchant;
      if (prior && (prior.mode !== body.mode || prior.title !== title || prior.amount_units !== amount)) {
        throw new RequestError(409, 'This request ID is already in use.');
      }
      if (prior) return sendJson(response, 200, { order: store.view(prior) });
      if (!recipient) throw new RequestError(409, 'Set MERCHANT_WALLET in .env and restart to open a Devnet booth.');
      // Creating requests only needs a public wallet address; outages must not stop the queue.
      const order = store.create({ id: body.id, mode: body.mode, title, amount, recipient });
      return sendJson(response, 201, { order: store.view(order) });
    }
    const orderPath = /^\/api\/orders\/([0-9a-f-]+)(?:\/(check|simulate))?$/.exec(path);
    if (orderPath && uuid.test(orderPath[1])) {
      const [, id, action] = orderPath;
      const order = store.get(id);
      if (!order) throw new RequestError(404, 'This payment request was not found.');
      if (method === 'GET' && !action) return sendJson(response, 200, { order: store.view(order) });
      if (method === 'POST' && action) {
        const body = await jsonBody(request);
        if (action === 'check') {
          fields(body,['signature']);
          if (order.mode === 'demo') return sendJson(response, 200, { order: store.view(order), note: 'Demo ledger refreshed.' });
          const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
          if (Object.hasOwn(body, 'signature') && !isSignature(signature)) {
            throw new RequestError(400, 'Enter a valid Solana transaction signature.');
          }
          return sendJson(response, 200, await checkOrder(order, signature));
        }
        if (order.mode !== 'demo') throw new RequestError(409, 'Demo transactions cannot settle Devnet orders.');
        const current = store.view(order);
        if (current.invoice) {
          fields(body,['scenario']);
          if(body.scenario==='recovery') {
            const sample=demoRecovery(store.invoice(id),now());
            const result=await payments.verify(store.invoice(id),sample.signature);
            return sendJson(response,200,{...result,order:store.view(store.get(id))});
          }
          const allowed = ['partial', 'remaining', 'deposit', 'overpay', 'wrong-token'];
          if (!allowed.includes(body.scenario)) throw new RequestError(400, 'Choose an invoice payment scenario.');
          const remaining = BigInt(current.invoice.remaining_units);
          if (body.scenario !== 'overpay' && remaining === 0n) {
            return sendJson(response, 200, { order: current });
          }
          let amount = remaining;
          if (body.scenario === 'partial') amount = BigInt(order.amount_units) * 3n / 5n;
          if (body.scenario === 'deposit') amount=BigInt(store.paymentRequest(id,'deposit').amount_units);
          if (body.scenario === 'overpay') amount = remaining + 1_000_000n;
          if (amount === 0n) amount = 1n;
          const sample = demoTransfer(order, body.scenario, now(), amount.toString());
          payments.commit(order,verifyPayment(store.invoice(id),sample.signature,sample.transaction,{knownReferences:store.references(),now:new Date(now()).toISOString()}));
          return sendJson(response, 200, { order: store.view(store.get(id)) });
        }
        if (!demoScenarios.has(body.scenario)) throw new RequestError(400, 'Choose a demo scenario.');
        if (body.scenario === 'duplicate' && !order.accepted_signature) {
          throw new RequestError(409, 'Settle the demo order once before trying a second payment.');
        }
        if (body.scenario === 'exact' && order.accepted_signature) {
          return sendJson(response, 200, { order: store.view(order) });
        }
        const sample = demoTransfer(order, body.scenario);
        payments.commit(order,verifyPayment(order,sample.signature,sample.transaction,{knownReferences:store.references(),requireReference:true,now:new Date(now()).toISOString()}));
        return sendJson(response, 200, { order: store.view(store.get(id)) });
      }
      throw new RequestError(405, 'This method is not supported for that order.');
    }
    if (path.startsWith('/api/')) throw new RequestError(404, 'This endpoint does not exist.');

    const file = files.get(isAppPage ? '/index.html' : path);
    if (!file || (method !== 'GET' && method !== 'HEAD')) throw new RequestError(404, 'Page not found.');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('ETag', file.tag);
    if (request.headers['if-none-match'] === file.tag) {
      response.writeHead(304);
      return response.end();
    }
    response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length });
    response.end(method === 'HEAD' ? undefined : file.body);
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 8_000 }, (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    handle(request, response).catch(error => {
      const status = error instanceof RequestError || error instanceof InvoiceError || error instanceof PaymentError
        ? error.status : error instanceof RpcUnavailable ? 503 : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) {
        sendJson(response, status, { error: status === 500 ? 'The application could not complete this request. Please try again.' : error.message,
          code:error.code??(error instanceof RpcUnavailable?'RPC_UNAVAILABLE':status===500?'INTERNAL_ERROR':'INVALID_REQUEST'),retryable:status===503||status===429,
          ...(error.invoice?{invoice:error.invoice}:{}) });
      }
    });
  });
  if(monitoring) server.on('listening',()=>monitor.start());
  const close=server.close.bind(server);
  server.close=callback=>{
    closing=true;
    const stopping=[monitor.stop(),payments.stop(),...activeChecks.values()];
    close(()=>void Promise.allSettled(stopping).then(()=>{store.close();callback?.();}));
    return server;
  };
  server.services={store,payments,monitor};
  return server;
}
