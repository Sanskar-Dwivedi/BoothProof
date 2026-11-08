import { revealWorkspace, revealPayment, revealRows } from './motion.js';

const $ = (selector, root = document) => root.querySelector(selector);
const content = $('#content');
const notice = $('#notice');
const modeSelect = $('#mode');
const checkoutId = /^\/pay\/([0-9a-f-]+)$/.exec(location.pathname)?.[1];
const views = new Set(['booth', 'invoices', 'recovery', 'ledger', 'guide']);
const modeNames = { demo: 'Demo mode', devnet: 'Solana Devnet' };
const states = { paid: 'Verified', review: 'Needs review', awaiting: 'Awaiting payment' };
const evidenceNames = {
  exact: 'Exact payment', amount: 'Wrong amount', mint: 'Wrong token',
  recipient: 'Wrong recipient', balance: 'Unexpected balance change', duplicate: 'Additional payment'
};
const state = {
  mode: sessionStorage.getItem('boothproof-mode') === 'devnet' ? 'devnet' : 'demo',
  orders: [], selected: null, checkout: null, config: null, filter: 'all',
  paymentOptionSelection: null,
  requestDraft: null, generation: 0, checking: false, jumpToDesk: false,
  invoices: [], invoiceSelected: null, invoiceFilter: 'all',payments:[],recoveryFilter:'unallocated',recoveryInvoice:null,dialogGeneration:0,
  requestSequence:0,mutationEpoch:0,savedOrders:new Map()
};

const paths = {
  arrow: 'M4 8h11m-5-5 5 5-5 5',
  external: 'M5 12 12 5M6 5h6v6',
  check: 'm3.5 8 3 3 6-6',
  clock: 'M8 4v4l3 2M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z',
  warning: 'M8 5v4m0 2.5h.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z',
  plus: 'M8 3v10M3 8h10',
  receipt: 'M4 2h8v12l-2-1-2 1-2-1-2 1V2Zm2 4h4M6 9h4',
  copy: 'M6 6h7v7H6zm-3 4V3h7',
  download: 'M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3',
  refresh: 'M13 6a5.1 5.1 0 1 0 .4 3.7M13 2.5V6H9.5',
  book: 'M8 4a5 5 0 0 0-5-1v9a6 6 0 0 1 5 1 6 6 0 0 1 5-1V3a5 5 0 0 0-5 1Zm0 0v9',
  link: 'm6 10 4-4m-5 1-2 2a2.8 2.8 0 0 0 4 4l2-2m2-2 2-2a2.8 2.8 0 0 0-4-4L7 5'
};
const icon = name => `<svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${paths[name]}" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const display = units => unitsLabel(units);
const wholeUnits = new Intl.NumberFormat('en-US');
const exactAmount = value => {
  const units = BigInt(value);
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return wholeUnits.format(units / 1_000_000n) + (fraction ? '.' + fraction : '');
};
const time = timestamp => timestamp ? new Date(timestamp).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
}) : 'Not available';
const short = value => `${value.slice(0, 8)}…${value.slice(-5)}`;
const orderLink = order => '/pay/' + order.id;
const explorer = signature => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
const currentView = () => views.has(location.hash.slice(1)) ? location.hash.slice(1) : 'invoices';
const activeOrder = () => currentView() === 'invoices'
  ? state.invoices.find(order => order.id === state.invoiceSelected) ?? null
  : state.orders.find(order => order.id === state.selected) ?? null;
const invoiceStates = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Reconciled', overpaid: 'Overpaid' };
const unitsLabel = value => {
  const formatted = exactAmount(value);
  return formatted.includes('.') ? formatted.padEnd(formatted.indexOf('.') + 3, '0') : formatted + '.00';
};

let noticeTimer;
function flash(message, isError = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.dataset.tone = isError ? 'error' : 'success';
  notice.classList.add('show');
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 4_200);
}

// Native adaptation of Spectrum's LoadingButton, retaining the existing request handlers.
const buttonContent = new WeakMap();
function setButtonBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!buttonContent.has(button)) buttonContent.set(button, button.innerHTML);
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${escape(label)}`;
    button.setAttribute('aria-busy', 'true');
  } else {
    if (buttonContent.has(button)) button.innerHTML = buttonContent.get(button);
    buttonContent.delete(button);
    button.removeAttribute('aria-busy');
  }
  button.disabled = busy;
}

async function api(path, data) {
  const sequence=++state.requestSequence,mutation=data!==undefined;
  if(mutation)state.mutationEpoch++;
  let response;
  try {
    response = await fetch('/api/' + path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
  } catch {
    if(mutation)state.mutationEpoch++;
    throw new Error('The booth server is offline. Reconnect and try again.');
  }
  let body;
  try{body=await response.json();}finally{if(mutation)state.mutationEpoch++;}
  if(body.order)body.order=rememberSavedOrder(body.order,sequence);
  if(Array.isArray(body.invoices))body.invoices=body.invoices.map(order=>rememberSavedOrder(order,sequence));
  if(Array.isArray(body.orders))body.orders=body.orders.map(order=>rememberSavedOrder(order,sequence));
  if(checkoutId&&body.invoice?.id) {
    const financialRevision=body.invoice.invoice?.financial_revision;
    body.invoice=rememberSavedOrder(body.invoice,sequence);
    if(body.option&&financialRevision!==body.invoice.invoice?.financial_revision)body.stale=true;
  }
  if (!response.ok) {
    const error=new Error(body.error || 'The request could not be completed.');
    error.code=body.code;error.status=response.status;error.body=body;throw error;
  }
  return body;
}

// Reversals can reduce received amounts, so compare durable revisions rather than balances.
function rememberSavedOrder(order,sequence) {
  if(!order?.id)return order;
  const saved=state.savedOrders.get(order.id),incoming=BigInt(order.revision??'0');
  if(saved) {
    const current=BigInt(saved.order.revision??'0');
    if(incoming<current||(incoming===current&&(sequence===undefined||sequence<saved.sequence)))return saved.order;
  }
  state.savedOrders.set(order.id,{order,sequence:sequence??state.requestSequence});
  return order;
}

// Preserve drafts and focus when saved data changes beneath a payment panel.
function rememberInputs(root) {
  const focused=document.activeElement;
  const action=focused&&root.contains(focused)&&focused.matches('button,a,summary')?{tag:focused.tagName,text:focused.textContent,data:Object.entries(focused.dataset)}:null;
  const values=[...root.querySelectorAll('input,textarea,select')].filter(el=>el.type!=='file').map(el=>({id:el.id,name:el.name,value:el.value,start:el.selectionStart,end:el.selectionEnd,focused:el===document.activeElement}));
  const detailKey=el=>el.querySelector('summary')?.textContent.trim().replace(/\s*·\s*\d+$/,'');
  const details=new Map([...root.querySelectorAll('details')].map(el=>[detailKey(el),el.open]));
  return ()=>{
    root.querySelectorAll('details').forEach(el=>{if(details.has(detailKey(el)))el.open=details.get(detailKey(el));});
    for(const item of values) {
      const el=item.id?document.getElementById(item.id):[...root.querySelectorAll('input,textarea,select')].find(el=>el.name===item.name);
      if(!el||!root.contains(el))continue;el.value=item.value;
      if(item.focused){el.focus({preventScroll:true});if(item.start!==null&&['text','search','url','tel','password'].includes(el.type))el.setSelectionRange(item.start,item.end);}
    }
    if(action&&!focused.isConnected) {
      [...root.querySelectorAll('button,a,summary')].find(el=>el.tagName===action.tag&&el.textContent===action.text&&action.data.every(([key,value])=>el.dataset[key]===value))?.focus({preventScroll:true});
    }
  };
}

function monitoringBlock(order) {
  if(order.mode==='demo') return '<p class="monitor-state">Offline Demo · simulated evidence</p>';
  const m=order.monitoring;if(!m)return '';
  return `<div class="monitor-state" role="status"><strong>${m.catching_up?'Catching up':m.current?'Scan complete recently':m.next_attempt?'Waiting for next check':'Automatic monitoring window ended'}</strong>
    <span>Last attempt: ${time(m.last_attempt)} · Complete scan: ${time(m.last_complete)}</span>${m.last_error?`<p class="form-error">${escape(m.last_error)}</p>`:''}</div>`;
}

function pill(order) {
  if (order.invoice) {
    const color = { unpaid: 'awaiting', partial: 'awaiting', paid: 'paid', overpaid: 'review' }[order.invoice.state];
    const glyph = { awaiting: 'clock', paid: 'check', review: 'warning' }[color];
    return `<span class="status ${color}">${icon(glyph)}${invoiceStates[order.invoice.state]}</span>`;
  }
  const glyph = { paid: 'check', review: 'warning', awaiting: 'clock' }[order.status];
  return `<span class="status ${order.status}">${icon(glyph)}${states[order.status]}</span>`;
}

function orderTable(orders, inLedger) {
  if (!orders.length) return `<div class="table-empty">${icon('receipt')}<strong>No matching orders</strong><p>${inLedger ? 'Try a different ledger filter.' : 'Create a checkout to start your ledger.'}</p></div>`;
  return `<div class="table-scroll" role="region" aria-label="Payment orders" tabindex="0"><table>
    <caption class="sr-only">Payment requests with amounts, verification status, and inspection actions.</caption>
    <thead><tr><th scope="col">Order</th><th scope="col" class="amount-col">Amount</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
    <tbody>${orders.map(order => `<tr${order.id === state.selected ? ' class="selected-row"' : ''}>
      <td><strong>${escape(order.title)}</strong><span class="meta">#${order.code} <span aria-hidden="true">·</span> ${time(order.created_at)}</span></td>
      <td class="amount-col">${display(order.amount_units)} <span class="subunit">USDC</span></td>
      <td>${pill(order)}${order.status === 'paid' && order.exceptions ? `<span class="exception-count">${order.exceptions} to review</span>` : ''}</td>
      <td class="action-col"><button class="icon-button" type="button" data-select="${order.id}" aria-label="Inspect ${escape(order.title)}" ${inLedger ? '' : `aria-pressed="${order.id === state.selected}"`}>${icon('arrow')}</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function updateSummary() {
  const stats = $('#stats');
  if (!stats) return;
  const paid = state.orders.filter(order => order.status === 'paid');
  const open = state.orders.length - paid.length;
  const exceptions = state.orders.reduce((total, order) => total + order.exceptions, 0);
  const collected = paid.reduce((total, order) => total + BigInt(order.amount_units), 0n);
  stats.innerHTML = `
    <div class="stat"><span class="stat-icon green">${icon('check')}</span><div><div class="stat-label">Verified total</div><strong>${display(collected)} <small>USDC</small></strong></div></div>
    <div class="stat"><span class="stat-icon blue">${icon('clock')}</span><div><div class="stat-label">Open orders</div><strong>${open} <small>${open === 1 ? 'request' : 'requests'}</small></strong></div></div>
    <div class="stat"><span class="stat-icon amber">${icon('warning')}</span><div><div class="stat-label">Payment exceptions</div><strong>${exceptions} <small>to review</small></strong></div></div>`;
}

function renderTable() {
  const table = $('#orders');
  if (!table) return;
  const ledger = currentView() === 'ledger';
  const filtered = ledger ? state.orders.filter(order => state.filter === 'all' ||
    (state.filter === 'review' ? order.exceptions > 0 : order.status === state.filter)) : state.orders.slice(0, 6);
  table.innerHTML = orderTable(filtered, ledger);
  $('#order-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'order' : 'orders'}`;
}

let qrLibrary;
async function drawQr(node, value) {
  try {
    qrLibrary ??= import('/vendor/qrcode.mjs').then(module => module.default);
    const qr = (await qrLibrary)(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    if (node.isConnected) {
      node.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: 'Scan to open checkout' });
    }
  } catch {
    if (node.isConnected) node.textContent = 'QR unavailable. Use the link.';
  }
}

function receiptBlock(order) {
  return `<div class="receipt-proof">
    <span class="proof-mark">${icon('check')}</span>
    <div><strong>${order.invoice ? 'Invoice reconciled' : order.mode === 'demo' ? 'Demo receipt verified' : 'Verified on Solana Devnet'}</strong>
    <p>${display(order.amount_units)} USDC · ${time(order.receipt.observed_at)}<br>${order.invoice ? `${order.invoice.credit_count} verified ${order.invoice.credit_count === 1 ? 'payment' : 'payments'} · ` : ''}${order.mode === 'demo' ? 'Simulated settlement' : 'Finalized transaction'}</p></div>
  </div>
  <div class="proof-id">
    <span class="mono proof-short" title="${escape(order.receipt.signature)}">${short(order.receipt.signature)}</span>
    <span class="mono proof-full">${escape(order.receipt.signature)}</span>
    ${order.mode === 'devnet'
      ? `<a class="text-link" href="${explorer(order.receipt.signature)}" target="_blank" rel="noreferrer">Explorer ${icon('external')}</a>`
      : `<button class="link-button" type="button" data-copy="${order.receipt.signature}">Copy demo ID ${icon('copy')}</button>`}
  </div>`;
}

function evidenceBlock(order) {
  if (order.invoice) {
    if (!order.evidence.length) return '';
    return `<details class="evidence invoice-history" open><summary>Payment history · ${order.evidence.length}</summary><ul>
      ${order.evidence.map(entry => `<li><div><strong>${entry.kind === 'credit' ? `${unitsLabel(entry.amount)} USDC received` : evidenceNames[entry.kind]}</strong>
        <p>${entry.kind === 'credit' ? 'Verified credit toward this invoice.' : 'Excluded from the received total.'}</p>
        <span class="mono">${short(entry.signature)}</span></div>
        ${order.mode === 'devnet' ? `<a class="icon-button" href="${explorer(entry.signature)}" target="_blank" rel="noreferrer" aria-label="View payment on Explorer">${icon('external')}</a>` : ''}</li>`).join('')}
    </ul></details>`;
  }
  const entries = order.evidence.filter(entry => entry.kind !== 'exact');
  if (!entries.length) return '';
  return `<details class="evidence" ${order.status === 'review' ? 'open' : ''}>
    <summary>${icon('warning')}${entries.length} payment ${entries.length === 1 ? 'exception' : 'exceptions'}</summary>
    <ul>${entries.map(entry => `<li>
      <div><strong>${evidenceNames[entry.kind]}</strong><p>${entry.kind === 'amount'
        ? `Received ${exactAmount(entry.amount)} USDC. Expected ${display(order.amount_units)} USDC.`
        : entry.kind === 'duplicate' ? 'The original receipt still counts once.' : 'This transfer does not settle the order.'}</p></div>
      ${order.mode === 'devnet' ? `<a class="icon-button" href="${explorer(entry.signature)}" target="_blank" rel="noreferrer" aria-label="Inspect exception on Explorer">${icon('external')}</a>` : ''}
    </li>`).join('')}</ul>
  </details>`;
}

function demoActions(order) {
  if (order.invoice) {
    const invoice = order.invoice;
    return `<details class="demo-actions"><summary>Practice invoice payments · offline</summary><div class="scenario-row">
      <button class="button quiet small" type="button" data-scenario="recovery">Practice reference-free 30 USDC</button>
      ${invoice.received_units === '0' ? `<button class="button quiet small" type="button" data-scenario="partial">Simulate 60% payment</button>
        <button class="button quiet small" type="button" data-scenario="wrong-token">Wrong token</button>` : ''}
      <button class="button quiet small" type="button" data-scenario="overpay">Overpay by 1 USDC</button>
    </div></details>`;
  }
  const tried = new Set(order.evidence.map(entry => entry.kind));
  return `<details class="demo-actions"><summary>Practice payment scenarios</summary><div class="scenario-row">
    ${order.receipt ? `<button class="button quiet small" type="button" data-scenario="duplicate" ${tried.has('duplicate') ? 'disabled' : ''}>Second payment</button>` :
      `<button class="button quiet small" type="button" data-scenario="short" ${tried.has('amount') ? 'disabled' : ''}>Wrong amount</button>
      <button class="button quiet small" type="button" data-scenario="wrong-token" ${tried.has('mint') ? 'disabled' : ''}>Wrong token</button>`}
  </div></details>`;
}

function signatureForm(label='Verify a specific signature',{open=false}={}) {
  return `<details class="demo-actions signature-entry" ${open?'open':''}><summary>${label}</summary>
    <form class="signature-form" id="signature-form">
      <label for="signature">Transaction signature</label>
      <input id="signature" name="signature" maxlength="90" placeholder="Paste a Solana signature" required autocomplete="off" spellcheck="false">
      <button class="button quiet small" type="submit">Verify</button>
    </form>
  </details>`;
}

function reviewBlock(order) {
  if(!order.review_cases?.length)return '';
  return `<section class="review-list" tabindex="-1"><h3>Payment exceptions</h3>${order.review_cases.map(c=>`<article class="review-case">
    <div><strong>${c.reason==='overpayment'?'Excess payment':escape(c.evidence.reason??evidenceNames[c.reason]??c.reason)}</strong><p>${escape(c.state)} · ${c.signature?short(c.signature):`${unitsLabel(order.invoice.excess_units)} USDC excess`}</p></div>
    ${c.state!=='cleared'?`<button class="button quiet small" data-review="${c.id}" data-review-action="${c.state==='open'?'acknowledge':'reopen'}">${c.state==='open'?'Acknowledge':'Reopen'}</button>`:''}
  </article>`).join('')}<p class="inline-note">Acknowledgment records a decision. It changes no balance and performs no refund.</p></section>`;
}
function timelineBlock(order) {
  const names={invoice_created:'Invoice created',verified_transfer:'Transfer verified',reference_allocation:'Reference payment allocated',manual_allocation:'Payment assigned',allocation_reversed:'Assignment reversed',legacy_allocation:'Legacy payment preserved',exception_observed:'Exception observed',review_acknowledge:'Review acknowledged',review_reopen:'Review reopened',review_reopened:'Review reopened by new evidence',review_cleared:'Excess cleared',overpayment_observed:'Overpayment detected'};
  return `<details class="evidence invoice-history"><summary>Allocation and decision timeline · ${order.timeline?.length??0}</summary><ul>${[...(order.timeline??[])].reverse().map(e=>`<li><div>
    <strong>${names[e.kind]??escape(e.kind)}${e.amount_units?` · ${unitsLabel(e.amount_units)} USDC`:''}</strong><p>${time(e.timestamp)} · ${escape(e.actor)}${e.details.note?`<br>${escape(e.details.note)}`:''}</p>
    ${e.payment_signature?`<span class="mono">${short(e.payment_signature)}</span>`:''}</div></li>`).join('')}</ul></details>
    ${order.payments?.filter(p=>p.allocation_method==='manual').map(p=>`<div class="manual-allocation"><span>${unitsLabel(p.amount_units)} USDC · Manual assignment</span><button class="link-button" data-reverse="${p.signature}">Reverse assignment</button></div>`).join('')??''}`;
}

function recovery() {
  return `<section class="page-intro invoice-intro"><div><p class="eyebrow">VERIFIED TRANSFERS</p><h1>Put payments in place.</h1><p class="intro">A transfer proves receipt. Your assignment decides which invoice receives credit.</p></div><span class="context-badge">${modeNames[state.mode]}</span></section>
    <section class="panel recovery-panel"><div class="table-head"><div><h2>Payment registry</h2><p>Source wallets are on-chain evidence, not verified client identities.</p></div></div>
    <div id="recovery-context"></div><div class="filters" aria-label="Filter payments">${[['unallocated','Unallocated'],['allocated','Allocated'],['all','All payments']].map(([key,label])=>`<button data-recovery-filter="${key}" aria-pressed="${state.recoveryFilter===key}">${label}</button>`).join('')}</div><div id="recovery-list"></div></section>`;
}
function renderRecovery() {
  const list=$('#recovery-list');if(!list)return;
  const restore=rememberInputs(list);
  const selected=state.invoices.find(o=>o.id===state.recoveryInvoice);
  $('#recovery-context').innerHTML=selected?`<div class="recovery-context">Reports for ${escape(selected.invoice.invoice_number)}<button class="link-button" data-clear-recovery>Show all invoices</button></div>`:'';
  const payments=state.payments.filter(p=>(!state.recoveryInvoice||p.suggested_invoice_id===state.recoveryInvoice||p.allocated_order_id===state.recoveryInvoice)&&
    (state.recoveryFilter==='all'||(state.recoveryFilter==='allocated'?p.allocated_order_id:!p.allocated_order_id)));
  list.innerHTML=payments.length?payments.map(p=>{
    const suggested=state.invoices.find(o=>o.id===p.suggested_invoice_id),allocated=state.invoices.find(o=>o.id===p.allocated_order_id);
    return `<article class="recovered-payment"><div class="recovery-heading"><h3>${unitsLabel(p.amount_units)} <small>USDC</small></h3><span class="status ${p.allocated_order_id?'paid':'awaiting'}">${p.allocated_order_id?'Allocated':'Awaiting assignment'}</span></div>
    <dl class="payment-facts"><div><dt>Source wallet · identity unconfirmed</dt><dd class="mono">${escape(p.source_owner??'Unknown · legacy evidence')}</dd></div><div><dt>Receiving wallet</dt><dd class="mono">${escape(p.recipient)}</dd></div>
    <div><dt>Reported invoice suggestion</dt><dd>${suggested?escape(suggested.invoice.invoice_number)+' · '+escape(suggested.invoice.client):'None'}${suggested?' · not a binding match':''}</dd></div>
    <div><dt>Verified</dt><dd>${time(p.verified_at)} · ${escape(p.provenance)}</dd></div><div><dt>Chain time</dt><dd>${p.chain_time?time(p.chain_time):'Unknown'}</dd></div>
    <div><dt>Allocation</dt><dd>${allocated?escape(allocated.invoice.invoice_number):p.allocated_order_id?'Legacy booth order':'Unallocated'}${p.allocation_method?' · '+p.allocation_method:''} · version ${p.allocation_version}</dd></div></dl>
    <div class="proof-id"><span class="mono proof-short" title="${p.signature}">${short(p.signature)}</span><button class="link-button" data-copy="${p.signature}">Copy signature</button>${p.mode==='devnet'?`<a class="text-link" href="${explorer(p.signature)}" target="_blank" rel="noreferrer">Explorer ${icon('external')}</a>`:'<span class="muted">Simulated · no on-chain transaction</span>'}</div>
    <div class="payment-buttons">${!p.allocated_order_id?`<button class="button primary small" data-allocate="${p.signature}">Assign to invoice ${icon('arrow')}</button>`:p.allocation_method==='manual'?`<button class="button quiet small" data-reverse="${p.signature}">Reverse assignment</button>`:''}</div></article>`;
  }).join(''):'<div class="table-empty"><strong>No matching verified payments</strong><p>Report a signature from an invoice checkout, or use the offline practice action.</p></div>';
  restore();
}

const decisionDialog=document.createElement('dialog');
decisionDialog.className='decision-dialog';document.body.append(decisionDialog);
decisionDialog.addEventListener('close',()=>{state.dialogGeneration++;});
decisionDialog.addEventListener('click',event=>{if(event.target.closest('[data-close-dialog]'))decisionDialog.close();});
function openDecision(html) {
  state.dialogGeneration++;decisionDialog.innerHTML=html;decisionDialog.showModal();
}
function allocationPreview() {
  const form=$('#allocation-form',decisionDialog);if(!form)return;
  if(form.dataset.uncertain==='true')return;
  const p=state.payments.find(p=>p.signature===form.dataset.signature),order=state.invoices.find(o=>o.id===form.elements.invoice_id.value);
  const preview=$('#allocation-preview',form),submit=$('button[type="submit"]',form);submit.disabled=!p||!order;
  form.dataset.previewStale='false';form.dataset.invoiceRevision='';
  $('[data-preview-stale]',form).textContent='';$('[data-refresh-preview]',form).hidden=true;
  if(!p||!order){preview.textContent='Choose an invoice to preview the full payment assignment.';return;}
  if(p.allocated_order_id){invalidateAllocationPreview('This payment has already been allocated. Close this dialog and inspect the saved assignment.');return;}
  form.dataset.previewInvoice=order.id;form.dataset.invoiceRevision=order.invoice.financial_revision;
  form.dataset.version=String(p.allocation_version);
  const before=BigInt(order.invoice.received_units),after=before+BigInt(p.amount_units),expected=BigInt(order.amount_units),remaining=after<expected?expected-after:0n,excess=after>expected?after-expected:0n;
  preview.innerHTML=`<strong>${escape(order.invoice.invoice_number)} · ${escape(order.invoice.client)}</strong><dl class="allocation-preview"><div><dt>Received before</dt><dd>${unitsLabel(before)} USDC</dd></div><div><dt>Received after</dt><dd>${unitsLabel(after)} USDC</dd></div><div><dt>Remaining balance</dt><dd>${unitsLabel(remaining)} USDC</dd></div><div><dt>Resulting excess</dt><dd>${unitsLabel(excess)} USDC</dd></div></dl>${excess>0n?'<p class="overpayment-note">This assignment creates an overpayment. Its excess will remain visible for review.</p>':''}`;
  $('[data-decision-error]',form).textContent='';
  syncDecisionButton(form);
}
function invalidateAllocationPreview(message) {
  const form=$('#allocation-form',decisionDialog);if(!form||form.dataset.uncertain==='true')return;
  form.dataset.previewStale='true';$('[data-preview-stale]',form).textContent=message;
  $('[data-refresh-preview]',form).hidden=false;syncDecisionButton(form);
}
function validateAllocationPreview() {
  const form=$('#allocation-form',decisionDialog);
  if(!decisionDialog.open||!form||!form.dataset.invoiceRevision||form.dataset.uncertain==='true')return;
  const invoice=state.invoices.find(o=>o.id===form.dataset.previewInvoice),p=state.payments.find(p=>p.signature===form.dataset.signature);
  if(!invoice||!p||p.allocated_order_id||String(p.allocation_version)!==form.dataset.version||invoice.invoice.financial_revision!==form.dataset.invoiceRevision) {
    invalidateAllocationPreview('The payment or invoice balance changed. Refresh this preview and confirm the updated totals.');
  }
}
function syncDecisionButton(form) {
  const button=$('button[type="submit"]',form);if(!button||button.hasAttribute('aria-busy'))return;
  if(form.dataset.uncertain==='true'){button.disabled=false;button.textContent='Retry saved decision';return;}
  if(form.id==='allocation-form'){button.disabled=form.dataset.previewStale==='true'||!form.dataset.invoiceRevision;button.textContent='Confirm assignment';}
}
function allocationDialog(signature) {
  const p=state.payments.find(p=>p.signature===signature);if(!p||p.allocated_order_id)return;
  const compatible=state.invoices.filter(o=>o.mode===p.mode&&o.recipient===p.recipient);
  openDecision(`<form id="allocation-form" data-signature="${signature}" data-version="${p.allocation_version}"><h2>Assign ${unitsLabel(p.amount_units)} USDC</h2><p>The entire verified payment will credit one invoice.</p>
    <label>Invoice<select name="invoice_id" required><option value="">Choose an invoice</option>${compatible.map(o=>`<option value="${o.id}">${escape(o.invoice.invoice_number)} · ${escape(o.invoice.client)}</option>`).join('')}</select></label>
    <div id="allocation-preview" aria-live="polite"></div><p class="form-error" data-preview-stale role="alert"></p><button class="button quiet small" type="button" data-refresh-preview hidden>Refresh preview</button><label>Decision note (optional)<textarea name="note" maxlength="500" rows="3"></textarea></label>
    <p class="form-error" data-decision-error aria-live="polite"></p><div class="payment-buttons"><button class="button primary" type="submit" disabled>Confirm assignment</button><button class="button quiet" type="button" data-close-dialog>Cancel</button></div></form>`);
  allocationPreview();
}
function reverseDialog(signature) {
  const p=state.payments.find(p=>p.signature===signature);if(!p||p.allocation_method!=='manual')return;
  openDecision(`<form id="decision-form" data-path="payments/${signature}/unallocate" data-version="${p.allocation_version}" data-kind="reverse"><h2>Reverse assignment</h2><p>Remove ${unitsLabel(p.amount_units)} USDC of invoice credit. The verified transfer and its history remain saved.</p><label>Reason<textarea name="note" required maxlength="500" rows="3"></textarea></label><p class="form-error" data-decision-error aria-live="polite"></p><div class="payment-buttons"><button class="button primary" type="submit">Confirm reversal</button><button class="button quiet" type="button" data-close-dialog>Cancel</button></div></form>`);
}
function reviewDialog(caseId,action) {
  const order=activeOrder(),c=order?.review_cases?.find(c=>c.id===caseId);if(!c)return;
  openDecision(`<form id="decision-form" data-path="invoices/${order.id}/review-decisions" data-version="${c.version}" data-case="${c.id}" data-kind="${action}"><h2>${action==='acknowledge'?'Acknowledge exception':'Reopen review'}</h2><p>This decision changes the attention flag only. It changes no balance and performs no refund.</p><label>Decision note<textarea name="note" required maxlength="500" rows="3"></textarea></label><p class="form-error" data-decision-error aria-live="polite"></p><div class="payment-buttons"><button class="button primary" type="submit">Save decision</button><button class="button quiet" type="button" data-close-dialog>Cancel</button></div></form>`);
}
decisionDialog.addEventListener('change',event=>{if(event.target.name==='invoice_id')allocationPreview();});
decisionDialog.addEventListener('click',event=>{if(event.target.closest('[data-refresh-preview]'))allocationPreview();});
decisionDialog.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target,button=$('button[type="submit"]',form),generation=state.dialogGeneration,mode=state.mode;
  const values=new FormData(form);let path,payload;
  if(form.dataset.uncertain==='true'){({path,payload}=JSON.parse(form.dataset.pendingDecision));}
  else if(form.id==='allocation-form') {
    validateAllocationPreview();if(form.dataset.previewStale==='true'||!form.dataset.invoiceRevision)return;
    path=`payments/${form.dataset.signature}/allocate`;payload={invoice_id:values.get('invoice_id'),expected_version:Number(form.dataset.version),expected_invoice_revision:form.dataset.invoiceRevision,note:values.get('note').trim()};
  }
  else {path=form.dataset.path;payload={expected_version:Number(form.dataset.version),...(form.dataset.kind==='reverse'?{reason:values.get('note').trim()}:{case_id:form.dataset.case,action:form.dataset.kind,note:values.get('note').trim()})};}
  const key=JSON.stringify([path,payload]);
  let drafts;try{drafts=JSON.parse(sessionStorage.getItem('boothproof-decisions')??'{}');}catch{drafts={};}
  const request_id=drafts[key]??crypto.randomUUID();drafts[key]=request_id;sessionStorage.setItem('boothproof-decisions',JSON.stringify(drafts));
  form.dataset.pendingDecision=JSON.stringify({path,payload});
  setButtonBusy(button,true,'Saving…');
  try {
    const result=await api(path,{...payload,request_id});delete drafts[key];sessionStorage.setItem('boothproof-decisions',JSON.stringify(drafts));
    if(mode!==state.mode||generation!==state.dialogGeneration)return;
    if(result.order)acceptOrder(result.order);
    decisionDialog.close();await refreshSavedState();flash('Decision saved. Balances refreshed.');
  } catch(error) {
    if(mode!==state.mode||generation!==state.dialogGeneration)return;
    if(error.code==='STALE_INVOICE') {
      delete drafts[key];sessionStorage.setItem('boothproof-decisions',JSON.stringify(drafts));
      form.dataset.uncertain='false';form.querySelectorAll('select,textarea').forEach(el=>el.disabled=false);
      await refreshSavedState();invalidateAllocationPreview(error.message);
    } else if(error.code==='STALE_VERSION'||error.code==='REQUEST_ID_CONFLICT') {
      delete drafts[key];sessionStorage.setItem('boothproof-decisions',JSON.stringify(drafts));decisionDialog.close();await refreshSavedState();flash(error.message+' Make a new decision.',true);
    } else {
      $('[data-decision-error]',form).textContent=error.message;
      if(!error.status||error.status>=500) {
        form.dataset.uncertain='true';form.querySelectorAll('select,textarea').forEach(el=>el.disabled=true);
        if(form.id==='allocation-form')$('[data-refresh-preview]',form).hidden=true;
        $('[data-decision-error]',form).textContent+=' Retry the same saved decision to check its outcome.';
      }
    }
  } finally {setButtonBusy(button,false);syncDecisionButton(form);}
});

function renderActive(motion = {}) {
  const panel = $('#payment-content');
  if (!panel) return;
  const order = activeOrder();
  const restore=panel.dataset.order===order?.id?rememberInputs(panel):()=>{};
  panel.dataset.order=order?.id??'';
  if (!order) {
    panel.innerHTML = `<div class="payment-empty"><span class="empty-mark">${icon('receipt')}</span><strong>${currentView() === 'invoices' ? 'See what each client owes' : 'Your next receipt starts here'}</strong><p>${currentView() === 'invoices' ? 'Create an invoice or import your client list to begin.' : 'Create a checkout or inspect an order from the queue.'}</p></div>`;
    return;
  }
  const receiptReplay = state.config?.devnetReceiptReplay && order.mode === 'devnet';
  const link = new URL(orderLink(order), location.origin).href;
  const invoice = order.invoice;
  const remaining = invoice ? BigInt(invoice.remaining_units) : BigInt(order.amount_units);
  panel.innerHTML = `
    <div class="payment-heading"><div><span class="eyebrow">${invoice ? escape(invoice.invoice_number) : 'ORDER #' + order.code}</span><h3>${escape(order.title)}</h3></div>${pill(order)}</div>
    ${invoice ? `<p class="invoice-client">${escape(invoice.client)} · Due ${invoice.due_date}${invoice.overdue ? ' · Overdue' : ''}</p>
      <dl class="invoice-balances" aria-label="Amounts in USDC"><div><dt>Expected</dt><dd>${display(order.amount_units)}</dd></div><div><dt>Received</dt><dd>${unitsLabel(invoice.received_units)}</dd></div><div><dt>Remaining</dt><dd>${unitsLabel(invoice.remaining_units)}</dd></div></dl>` : ''}
    ${invoice?.state === 'overpaid' ? `<p class="overpayment-note">Overpaid by ${unitsLabel(invoice.overpaid_units)} USDC. Review the verified transfers before arranging a refund.</p>` : ''}
    ${invoice?`${signatureForm('I already paid · verify a signature',{open:true})}
      ${order.recovery?.awaiting_allocation?`<div class="recovery-report" role="status"><strong>${unitsLabel(order.recovery.payments.reduce((sum,p)=>sum+BigInt(p.amount_units),0n))} USDC verified · unallocated</strong><p>This transfer has not reduced the invoice balance. Inspect the report before requesting another payment.</p><button class="button quiet small" data-inspect-recovery="${order.id}">Inspect recovery report ${icon('arrow')}</button></div>`:''}`:''}
    ${order.receipt ? receiptBlock(order) : remaining > 0n ? `
      <div class="payment-core">
        ${receiptReplay ? '' : '<div class="qr" data-qr></div>'}
        <div><div class="due">${invoice ? unitsLabel(invoice.remaining_units) : display(order.amount_units)} <small>USDC</small></div>
          <p>${receiptReplay ? 'Open checkout to review the recorded Devnet payment.' : 'Scan to open the customer checkout.'}</p>
          <a class="text-link" href="${orderLink(order)}">Open checkout ${icon('external')}</a>
        </div>
      </div>` : ''}
    <div class="payment-buttons">
      ${order.mode === 'devnet'
        ? `<button class="button quiet small" type="button" data-action="check">${icon('refresh')} Check payment</button>`
        : invoice ? `${remaining > 0n ? `<button class="button quiet small" type="button" data-scenario="remaining">Pay remaining balance</button>` : ''}<a class="button quiet small" href="${orderLink(order)}">Open statement ${icon('external')}</a>`
        : order.receipt ? `<a class="button quiet small" href="${orderLink(order)}">${icon('receipt')} Open receipt</a>`
        : `<button class="button quiet small" type="button" data-scenario="exact">${icon('check')} Simulate exact payment</button>`}
      <button class="icon-button copy-button" type="button" data-copy="${escape(link)}" aria-label="${invoice && remaining === 0n ? 'Copy statement link' : order.receipt ? 'Copy receipt link' : 'Copy checkout link'}">${icon('copy')}</button>
    </div>
    ${invoice?`${monitoringBlock(order)}${reviewBlock(order)}<div class="statement-tools"><a class="text-link" href="/api/invoices/${order.id}/history.csv" download>Export allocation history ${icon('download')}</a><a class="text-link" href="${orderLink(order)}">Printable statement ${icon('external')}</a></div>`:''}
    ${evidenceBlock(order)}${invoice?timelineBlock(order):''}
    ${order.mode === 'demo' ? demoActions(order) : invoice?'':signatureForm()}
    <p class="inline-note" id="payment-note" aria-live="polite"></p>`;
  const qr = $('[data-qr]', panel);
  if (qr) void drawQr(qr, link);
  restore();
  revealPayment(panel, motion);
}

function booth() {
  const missingWallet = state.mode === 'devnet' && !state.config.devnetConfigured;
  return `
    <section class="hero">
      <div class="hero-copy"><p class="eyebrow">USDC PAYMENT WORKSPACE</p>
        <h1>Payments, with proof.</h1>
        <p class="intro">Create a request. Verify the transfer. Keep a receipt you can check.</p>
      </div>
      <img class="hero-art" src="/booth-art.svg" alt="" width="420" height="200">
    </section>
    <section class="stats" id="stats" aria-label="Booth summary"></section>
    <div class="desk-grid">
      <section class="panel create-panel" aria-labelledby="create-title">
        <div class="panel-head"><span class="panel-icon">${icon('plus')}</span><div><h2 id="create-title">New checkout</h2><p>Create a payment request for one order.</p></div></div>
        ${missingWallet ? `<div class="setup"><strong>Set up your Devnet booth</strong><p>Add your public receiving wallet to the local configuration to create payment requests.</p><a class="text-link" href="#guide">Read setup steps ${icon('arrow')}</a></div>` :
          `<form id="checkout-form">
            <div class="field-grid">
              <label>Item or order name<input name="title" placeholder="e.g. Bake sale box" maxlength="60" required autocomplete="off"></label>
              <label>Amount<span class="money-field"><input name="amount" placeholder="0.00" inputmode="decimal" pattern="(?:0|[1-9][0-9]{0,3})(?:[.][0-9]{1,2})?" maxlength="7" required autocomplete="off"><span>USDC</span></span></label>
            </div>
            <div class="preset-row"><span>Quick items</span>
              <button type="button" data-preset="coffee">Iced coffee</button>
              <button type="button" data-preset="cookies">Bake sale box</button>
              <button type="button" data-preset="raffle">Raffle ticket</button>
            </div>
            <button class="button primary" type="submit">Create payment request ${icon('arrow')}</button>
            <p class="form-error" id="create-error" aria-live="polite"></p>
          </form>`}
        <p class="panel-foot"><span class="mode-dot"></span>${state.mode === 'demo' ? 'Demo activity is simulated. No funds move.' : 'Devnet uses test USDC. No real funds move.'}</p>
      </section>
      <section class="panel payment-panel" id="payment-desk" aria-labelledby="payment-title" tabindex="-1">
        <div class="panel-head"><span class="panel-icon">${icon('receipt')}</span><div><h2 id="payment-title">Payment desk</h2><p>Check the transfer before handing over the order.</p></div></div>
        <div id="payment-content"></div>
      </section>
    </div>
    <section class="panel orders-panel" aria-labelledby="orders-title">
      <div class="table-head"><div><h2 id="orders-title">Recent orders</h2><p id="order-count"></p></div><a class="text-link" href="#ledger">View ledger ${icon('arrow')}</a></div>
      <div id="orders"></div>
    </section>`;
}

function invoices() {
  const missingWallet = state.mode === 'devnet' && !state.config.devnetConfigured;
  return `
    <header class="workspace-header"><div><h1>Invoices</h1><p>Payment recovery and reconciliation</p></div><div class="workspace-actions"><span class="context-badge">${modeNames[state.mode]}</span>
      <button class="button quiet small" data-compose="import" aria-haspopup="dialog">Import CSV ${icon('download')}</button><button class="button primary small" data-compose="create" aria-haspopup="dialog">New invoice ${icon('plus')}</button></div></header>
    <section class="stats invoice-summary" id="invoice-stats" aria-label="Invoice summary"></section>
    <section class="panel attention-panel" id="attention-queue" aria-label="Attention queue"></section>
    <dialog class="compose-dialog" id="invoice-create-dialog" aria-labelledby="invoice-create-title"><div class="dialog-heading"><h2 id="invoice-create-title">New invoice</h2><button class="button quiet small" type="button" data-close-compose>Cancel</button></div>
        ${missingWallet ? `<div class="setup"><strong>Set up your receiving wallet</strong><p>Add MERCHANT_WALLET to your local configuration and restart.</p><a class="text-link" href="#guide">Read setup steps ${icon('arrow')}</a></div>` :
          `<form id="invoice-form"><div class="invoice-fields">
            <label>Invoice number<input name="invoice_number" maxlength="30" placeholder="INV-001" required autocomplete="off"></label>
            <label>Client<input name="client" maxlength="60" placeholder="Northstar Studio" required autocomplete="off"></label>
            <label class="full-field">Description<input name="title" maxlength="60" placeholder="Website design milestone" required autocomplete="off"></label>
            <label>Amount in USDC<input name="amount" inputmode="decimal" pattern="(?:0|[1-9][0-9]{0,3})(?:[.][0-9]{1,2})?" placeholder="50.00" maxlength="7" required autocomplete="off"></label>
            <label>Due date<input name="due_date" type="date" required></label>
            <label>Optional deposit in USDC<input name="deposit_amount" inputmode="decimal" pattern="(?:0|[1-9][0-9]{0,3})(?:[.][0-9]{1,2})?" placeholder="30.00" maxlength="7" autocomplete="off"></label>
          </div><button class="button primary" type="submit">Create invoice ${icon('arrow')}</button><p class="form-error" id="invoice-error" aria-live="polite"></p></form>`}
        <p class="panel-foot"><span class="mode-dot"></span>${state.mode === 'demo' ? 'Demo payments are simulated.' : 'Invoices collect test USDC on Devnet.'}</p>
    </dialog>
    <dialog class="compose-dialog" id="invoice-import-dialog" aria-labelledby="invoice-import-title"><div class="dialog-heading"><h2 id="invoice-import-title">Import CSV</h2><button class="button quiet small" type="button" data-close-compose>Cancel</button></div>
        <p>Use invoice_number, client, title, amount, due_date. Up to 100 invoices per file. Identical invoices are skipped.</p>
        <form id="invoice-import"><label>Invoice CSV<input type="file" name="file" accept=".csv,text/csv" required></label><button class="button quiet small" type="submit">Import CSV ${icon('plus')}</button><a class="text-link" href="/api/invoices/template.csv" download>Download example ${icon('download')}</a></form>
        <p class="form-error" id="import-error" aria-live="polite"></p>
    </dialog>
    <div class="mobile-invoice-picker"><label for="invoice-picker">Select invoice</label><div><select id="invoice-picker"></select><button class="button quiet small" data-reach-invoice>View details ${icon('arrow')}</button></div></div>
    <div class="invoice-workspace"><section class="panel orders-panel invoice-register-panel" aria-labelledby="register-title"><div class="table-head"><div><h2 id="register-title">Invoice register</h2><p id="invoice-count"></p></div>
      <a class="button quiet small" href="/api/invoices.csv?mode=${state.mode}" download>${icon('download')} Export statement</a></div>
      <div class="filters" aria-label="Filter invoices">${[['all', 'All invoices'], ['open', 'Outstanding'], ['overdue', 'Overdue'], ['paid', 'Reconciled'], ['review', 'Needs review']].map(([key, label]) =>
        `<button type="button" data-invoice-filter="${key}" aria-pressed="${state.invoiceFilter === key}">${label}</button>`).join('')}</div>
      <div id="invoice-register"></div>
    </section>
    <section class="panel payment-panel invoice-detail" id="payment-desk" aria-labelledby="payment-title" tabindex="-1">
      <div class="panel-head"><span class="panel-icon">${icon('receipt')}</span><div><h2 id="payment-title">Invoice desk</h2><p>Verified evidence and current allocations.</p></div></div><div id="payment-content"></div>
    </section></div>`;
}

function updateInvoices() {
  const stats = $('#invoice-stats');
  if (!stats) return;
  const restore=rememberInputs(content);
  const rows = state.invoices;
  const remaining = rows.reduce((total, order) => total + BigInt(order.invoice.remaining_units), 0n);
  const unallocated=state.payments.filter(p=>!p.allocated_order_id).length;
  const reviews=rows.reduce((total,order)=>total+order.invoice.issues,0);
  stats.innerHTML = `
    <div class="stat"><span class="stat-icon blue">${icon('clock')}</span><div><div class="stat-label">Outstanding balance</div><strong>${unitsLabel(remaining)} <small>USDC</small></strong></div></div>
    <div class="stat"><span class="stat-icon green">${icon('receipt')}</span><div><div class="stat-label">Unallocated payments</div><strong>${unallocated} <small>verified transfers</small></strong></div></div>
    <div class="stat"><span class="stat-icon amber">${icon('warning')}</span><div><div class="stat-label">Open review cases</div><strong>${reviews} <small>need attention</small></strong></div></div>`;
  const attention=$('#attention-queue');
  attention.innerHTML=`<strong>Attention</strong><div>${unallocated?`<a class="text-link" href="#recovery">Assign ${unallocated} verified ${unallocated===1?'payment':'payments'} ${icon('arrow')}</a>`:''}
    ${rows.filter(o=>o.invoice.issues).slice(0,1).map(o=>`<button class="link-button" data-attention="${o.id}">${escape(o.invoice.invoice_number)} · ${o.invoice.issues} review ${o.invoice.issues===1?'case':'cases'} ${icon('arrow')}</button>`).join('')}
    ${rows.filter(o=>o.invoice.issues).length>1?`<button class="link-button" data-review-queue>View all ${reviews} open reviews ${icon('arrow')}</button>`:''}
    ${!unallocated&&!reviews?'<span class="muted">No unallocated payments or open reviews.</span>':''}</div>`;
  const filtered = rows.filter(order => {
    const invoice = order.invoice;
    if (state.invoiceFilter === 'open') return BigInt(invoice.remaining_units) > 0n;
    if (state.invoiceFilter === 'overdue') return invoice.overdue;
    if (state.invoiceFilter === 'review') return invoice.issues > 0;
    if (state.invoiceFilter === 'paid') return invoice.state === 'paid';
    return true;
  });
  $('#invoice-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'invoice' : 'invoices'} · ${modeNames[state.mode]}`;
  $('#invoice-register').innerHTML = filtered.length ? `<div class="table-scroll" role="region" aria-label="Invoice balances" tabindex="0"><table class="invoice-table">
    <caption class="sr-only">Client invoices and their expected, received, and outstanding USDC balances.</caption>
    <thead><tr><th scope="col">Invoice / client</th><th scope="col">Remaining</th><th scope="col"><span class="sr-only">Inspect</span></th></tr></thead>
    <tbody>${filtered.map(order => `<tr${order.id === state.invoiceSelected ? ' class="selected-row"' : ''}><td><strong>${escape(order.invoice.invoice_number)}</strong><span class="meta">${escape(order.invoice.client)}</span></td>
      <td><strong>${unitsLabel(order.invoice.remaining_units)}</strong><span class="meta">of ${display(order.amount_units)} USDC</span></td>
      <td class="action-col"><button class="icon-button" type="button" data-select="${order.id}" aria-label="Inspect invoice ${escape(order.invoice.invoice_number)}" aria-pressed="${order.id === state.invoiceSelected}">${icon('arrow')}</button></td></tr>`).join('')}</tbody>
    </table></div>` : `<div class="table-empty">${icon('receipt')}<strong>No matching invoices</strong><p>Create an invoice or import a CSV.</p></div>`;
  $('#invoice-register').querySelectorAll('tbody tr').forEach((row,index)=>{
    const order=filtered[index];row.querySelector('td').insertAdjacentHTML('beforeend',`<span class="register-state">${pill(order)}${order.invoice.overdue?'<span class="exception-count">Overdue</span>':''}${order.invoice.issues?'<span class="exception-count">Review</span>':''}</span>`);
  });
  restore();
  const picker=$('#invoice-picker');picker.innerHTML=rows.map(o=>`<option value="${o.id}">${escape(o.invoice.invoice_number)} · ${escape(o.invoice.client)}</option>`).join('');picker.value=state.invoiceSelected??'';
  picker.disabled=!rows.length;$('[data-reach-invoice]').disabled=!rows.length;
}

function ledger() {
  return `
    <section class="page-intro"><p class="eyebrow">TRANSACTION RECORDS</p><h1>Payment ledger.</h1>
      <p class="intro">Review every request and export your records after the fundraiser.</p></section>
    <section class="stats" id="stats" aria-label="Booth summary"></section>
    <section class="panel orders-panel ledger-panel">
      <div class="table-head"><div><h2>${modeNames[state.mode]} orders</h2><p id="order-count"></p></div>
        <a class="button quiet small" href="/api/ledger.csv?mode=${state.mode}" download>${icon('download')} Export CSV</a></div>
      <div class="filters" aria-label="Filter orders">
        ${[['all', 'All orders'], ['paid', 'Verified'], ['awaiting', 'Awaiting'], ['review', 'Exceptions']].map(([key, label]) =>
          `<button type="button" data-filter="${key}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}
      </div>
      <div id="orders"></div>
    </section>`;
}

function guide() {
  return `
    <section class="page-intro"><p class="eyebrow">FIELD GUIDE</p><h1>Your first payment.</h1>
      <p class="intro">Start with the demo, then try the same checkout with test USDC on Solana Devnet.</p></section>
    <div class="guide-grid">
      <section class="panel guide-panel"><div class="panel-head"><span class="panel-icon">${icon('book')}</span><div><h2>Practice at the booth</h2><p>Everything runs locally.</p></div></div>
        <ol><li>Create a checkout for a sale.</li><li>Use <strong>Practice payment scenarios</strong> to send a wrong amount. The order should go to review.</li><li>Simulate the exact payment, then try a second payment. The receipt stays the same and the extra transfer is flagged.</li></ol>
        <a class="button primary small" href="#booth">Return to the booth ${icon('arrow')}</a>
      </section>
      <section class="panel guide-panel"><div class="panel-head"><span class="panel-icon green">${icon('link')}</span><div><h2>Use Solana Devnet</h2><p>Two wallets, test tokens only.</p></div></div>
        <ol><li>Copy <code>.env.example</code> to <code>.env</code>. Set <code>MERCHANT_WALLET</code> to the receiving wallet’s <strong>public</strong> address and restart the server.</li>
          <li>Set the payer wallet to Devnet. Get <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">test SOL</a> for fees and <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">test USDC</a> for the payment.</li>
          <li>Switch the booth to <strong>Solana Devnet</strong>, create a request, and scan it from a compatible wallet. Check the network and amount before signing.</li>
          <li>Wait for the verified receipt. If the history lookup misses it, paste the signature into the payment desk.</li></ol>
      </section>
      <section class="panel guide-panel guide-wide"><div class="panel-head"><span class="panel-icon">${icon('receipt')}</span><div><h2>Reconcile a client invoice</h2></div></div>
        <ol><li>Open <a href="#invoices">Invoices</a> and choose a 50 USDC invoice.</li><li>In Demo mode, expand practice payments and create a <strong>reference-free 30 USDC payment</strong>. It is verified but the invoice still owes 50 USDC.</li><li>Open <a href="#recovery">Recovery</a>, assign that payment, and confirm the 20 USDC remainder.</li><li>Pay the remaining balance in the customer checkout. Replaying a signature never adds credit twice.</li></ol>
        <p>Referenced payments allocate automatically. Other supported direct payments need your explicit assignment. Wallet addresses do not establish client identity. Manual assignments can be reversed with a reason; the transfer stays recorded.</p>
        <p>Devnet monitoring runs every 10 seconds for outstanding invoices and every 60 seconds for 24 hours after settlement changes. Catch-up scans resume after restart. Unsupported transfers and history gaps remain visible for review. Use a manual check after the automatic window ends.</p>
      </section>
      <section class="panel guide-panel guide-wide"><div class="panel-head"><span class="panel-icon amber">${icon('warning')}</span><div><h2>What the receipt proves</h2></div></div>
        <p>Boothproof checks the finalized transaction, its order reference, the USDC mint, the receiving wallet, and the exact credit. Additional payments and mismatches appear separately in the ledger. Demo receipts use simulated transactions and have no Explorer link.</p>
      </section>
    </div><p class="legacy-links">Legacy workspace: <a class="text-link" href="#booth">Booth checkout</a> · <a class="text-link" href="#ledger">Booth ledger</a>. Local access only; customer views are not an authentication boundary.</p>`;
}

function renderCheckout(order) {
  order=rememberSavedOrder(order);
  if(!order?.invoice) return renderLegacyCheckout(order);
  const previous=state.checkout,restore=previous?.id===order.id?rememberInputs(content):()=>{};
  if(previous?.invoice.received_units!==order.invoice.received_units) state.checkoutRequest=null;
  state.checkout=order;
  const invoice=order.invoice,request=state.checkoutRequest?.id===order.id?state.checkoutRequest:null;
  const option=request?.option??'balance',amount=request?.amount_units??invoice.remaining_units,paymentLink=request?.payment_url??order.payment_url;
  const checkoutLink = new URL(orderLink(order), location.origin).href;
  const remaining=BigInt(invoice.remaining_units)>0n;
  const wallet=order.mode==='devnet'?state.walletReview:null;
  const awaitingAssignment=order.recovery.awaiting_allocation>0;
  const direct=wallet&&!awaitingAssignment&&invoice.received_units==='0'&&invoice.deposit_units==='30000000';
  const phantomBalance=wallet&&!awaitingAssignment&&option==='balance'&&invoice.received_units==='30000000'&&
    invoice.remaining_units==='20000000'&&invoice.deposit_remaining_units==='0'&&invoice.credit_count===1;
  const reviewLabel=direct ? (wallet.replay?'Review recorded 30 USDC':'Send 30 USDC without a reference')
    : phantomBalance ? (wallet.replay?'Review in Phantom · receipt replay':'Review in Phantom') : null;
  document.body.dataset.mode=order.mode;document.body.dataset.view='customer';document.title='Invoice checkout — Boothproof';
  content.innerHTML=`<div class="customer-wrap"><a class="back-link" href="/#invoices">← Back to invoices</a><section class="panel customer-panel">
    <div class="customer-top"><span class="panel-icon">${icon('receipt')}</span><span class="context-badge">${modeNames[order.mode]}</span></div>
    <p class="eyebrow">${escape(invoice.invoice_number)}</p><h1>${escape(order.title)}</h1><p class="invoice-client">${escape(invoice.client)} · Due ${invoice.due_date}</p>
    <p class="customer-amount">${unitsLabel(invoice.remaining_units)} <small>USDC remaining</small></p>${pill(order)}
    <dl class="invoice-balances"><div><dt>Total</dt><dd>${unitsLabel(invoice.expected_units)}</dd></div><div><dt>Received</dt><dd>${unitsLabel(invoice.received_units)}</dd></div><div><dt>Excess</dt><dd>${unitsLabel(invoice.excess_units)}</dd></div></dl>
    ${BigInt(invoice.excess_units)>0n?`<p class="overpayment-note">${unitsLabel(invoice.excess_units)} USDC excess remains on this statement. Contact the merchant for review.</p>`:''}
    ${order.recovery.awaiting_allocation?'<p class="overpayment-note" role="status">Your reported transfer is verified and awaits merchant allocation. It has not reduced this balance. Wait for allocation before paying again.</p>':''}
    ${reviewLabel?`<div class="payment-buttons"><a class="button primary" href="${escape(wallet.url)}">${reviewLabel} ${icon('arrow')}</a></div>
      <p class="customer-help">${direct?'Review the direct transfer without an invoice reference.':`Review the ${unitsLabel(amount)} USDC balance with its invoice reference.`}</p>`:''}
    ${remaining&&!wallet?.replay&&!reviewLabel&&!(wallet&&awaitingAssignment)?`<div class="payment-options" aria-label="Choose payment amount">${BigInt(invoice.deposit_remaining_units)>0n?`<button class="button quiet small" data-payment-option="deposit" aria-pressed="${option==='deposit'}">Pay deposit · ${unitsLabel(invoice.deposit_remaining_units)} USDC</button>`:''}<button class="button quiet small" data-payment-option="balance" aria-pressed="${option==='balance'}">Pay remaining balance · ${unitsLabel(invoice.remaining_units)} USDC</button></div>
      <p class="customer-help">Selected request: ${unitsLabel(amount)} USDC. ${order.mode==='demo'?'Offline practice · no funds move.':'Use a Solana Pay wallet set to Devnet. Review the amount before signing.'}</p>
      ${order.mode==='demo'?`<button class="button primary" data-checkout-pay="${option}">Simulate ${option==='deposit'?'deposit':'remaining balance'} ${icon('arrow')}</button>`:`<div class="payment-buttons"><a class="button primary" href="${escape(paymentLink)}">Open in Solana Pay wallet ${icon('external')}</a></div>`}`:''}
    ${remaining&&order.mode==='devnet'&&!wallet?.replay?`<p class="customer-help">Scan to open the checkout page.</p><div class="qr customer-qr" data-qr></div><button class="button quiet" type="button" data-copy="${escape(checkoutLink)}">Copy checkout link ${icon('copy')}</button>`:''}
    <dl class="payment-facts"><div><dt>Receiving wallet</dt><dd class="mono">${escape(order.recipient)}</dd></div></dl>
    <div class="payment-buttons"><button class="button quiet small" data-action="check">${icon('refresh')} Check payment</button><button class="button quiet small" data-action="print">${icon('receipt')} Print statement</button></div>
    ${monitoringBlock(order)}${evidenceBlock(order)}${signatureForm('I already paid')}
    <p class="inline-note" id="payment-note" aria-live="polite"></p></section><p class="customer-caption">${wallet?.replay?'Replay of finalized Devnet payments in an isolated ledger':order.mode==='demo'?'Simulated evidence · no on-chain transaction':'Solana Devnet · test USDC only'}</p></div>`;
  const qr=$('[data-qr]');if(qr)void drawQr(qr,checkoutLink);
  restore();if(!previous)revealWorkspace(content);
}

function renderLegacyCheckout(order) {
  order=rememberSavedOrder(order);
  if (!order) return;
  const previous = state.checkout;
  const restore=previous?.id===order.id?rememberInputs(content):()=>{};
  state.checkout = order;
  document.body.dataset.mode = order.mode;
  document.body.dataset.view = 'customer';
  document.title = order.invoice ? 'Invoice statement — Boothproof' : order.receipt ? 'Receipt — Boothproof' : 'Checkout — Boothproof';
  content.innerHTML = `<div class="customer-wrap">
    <a class="back-link" href="/#${order.invoice ? 'invoices' : 'booth'}">← Back to ${order.invoice ? 'invoices' : 'booth'}</a>
    <section class="panel customer-panel">
      <div class="customer-top"><span class="panel-icon">${icon('receipt')}</span><span class="context-badge"><span class="mode-dot"></span>${modeNames[order.mode]}</span></div>
      <p class="eyebrow">${order.invoice ? escape(order.invoice.invoice_number) : 'ORDER #' + order.code}</p>
      <h1>${escape(order.title)}</h1>
      ${order.invoice ? `<p class="invoice-client">${escape(order.invoice.client)} · Due ${order.invoice.due_date}</p>` : ''}
      <p class="customer-amount">${order.invoice ? unitsLabel(order.invoice.remaining_units) : display(order.amount_units)} <small>USDC${order.invoice ? ' outstanding' : ''}</small></p>
      ${order.invoice ? `<p class="customer-help">Invoice total ${display(order.amount_units)} USDC · Received ${unitsLabel(order.invoice.received_units)} USDC</p>` : ''}
      ${pill(order)}
      ${order.invoice?.state === 'overpaid' ? `<p class="overpayment-note">Overpaid by ${unitsLabel(order.invoice.overpaid_units)} USDC. Contact the receiving agency to arrange a review.</p>` : ''}
      ${order.receipt ? `${receiptBlock(order)}<button class="button quiet" type="button" data-action="print">Print receipt ${icon('receipt')}</button>` :
        order.invoice?.remaining_units === '0' ? '' : order.mode === 'demo'
          ? `<p class="customer-help">This checkout is a practice run. No wallet or tokens are needed.</p><button class="button primary" type="button" data-scenario="${order.invoice ? 'remaining' : 'exact'}">${order.invoice ? 'Pay remaining balance' : 'Simulate payment'} ${icon('arrow')}</button>`
          : `<p class="customer-help">Use a compatible Solana Pay wallet on Devnet. Review the request in your wallet before signing.</p>
              <div class="qr customer-qr" data-qr></div>
              <div class="payment-buttons"><a class="button primary" href="${escape(order.payment_url)}">Open in wallet ${icon('external')}</a>
              <button class="button quiet" type="button" data-action="check">${icon('refresh')} Check payment</button></div>`}
      ${evidenceBlock(order)}
      ${order.mode === 'devnet' && !order.receipt ? signatureForm() : ''}
      <p class="inline-note" id="payment-note" aria-live="polite"></p>
    </section>
    <p class="customer-caption">${order.mode === 'demo' ? 'Demo receipt · No on-chain transaction' : 'Devnet receipt · Test tokens only'}</p>
  </div>`;
  const qr = $('[data-qr]');
  if (qr) void drawQr(qr, new URL(orderLink(order), location.origin).href);
  restore();
  if (!previous) revealWorkspace(content);
  else revealPayment(content, { settled: previous.status !== 'paid' && order.status === 'paid' });
}

function renderWorkspace() {
  const view = currentView();
  document.body.dataset.mode = state.mode;
  document.body.dataset.view = view;
  modeSelect.value = state.mode;
  document.querySelectorAll('[data-view]').forEach(link => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${{ booth: 'Fundraiser checkout', invoices: 'Invoice reconciliation', recovery:'Payment recovery', ledger: 'Payment ledger', guide: 'Field guide' }[view]} — Boothproof`;
  content.innerHTML = { booth, invoices, recovery, ledger, guide }[view]();
  updateSummary();
  updateInvoices();
  renderTable();
  renderActive();
  renderRecovery();
  revealWorkspace(content);
}

function messagePage(title, description) {
  content.innerHTML = `<section class="page-intro"><h1>${escape(title)}</h1><p class="intro">${escape(description)}</p><button class="button quiet" type="button" data-action="reload">${icon('refresh')} Retry</button></section>`;
}

async function loadWorkspace() {
  const generation = ++state.generation;
  const epoch=state.mutationEpoch;
  content.setAttribute('aria-busy', 'true');
  try {
    const [config, { orders }, { invoices }, {payments}] = await Promise.all([
      api('config'), api('orders?mode=' + state.mode), api('invoices?mode=' + state.mode),api('payments?mode='+state.mode)
    ]);
    if (generation !== state.generation||epoch!==state.mutationEpoch) return;
    state.config = config;
    modeNames.devnet = config.devnetReceiptReplay ? 'Devnet receipt replay' : 'Solana Devnet';
    state.orders = orders;
    state.invoices = invoices;
    state.payments=payments;
    if (!orders.some(order => order.id === state.selected)) state.selected = orders[0]?.id ?? null;
    if (!invoices.some(order => order.id === state.invoiceSelected)) {
      const saved=sessionStorage.getItem('boothproof-selected-invoice-'+state.mode);
      state.invoiceSelected=invoices.find(o=>o.id===saved)?.id??invoices.find(o=>o.invoice.invoice_number==='RECOVERY-050')?.id??invoices[0]?.id??null;
    }
    renderWorkspace();
  } catch (error) {
    if (generation === state.generation) messagePage('The booth is unavailable.', error.message);
  } finally {
    if (generation === state.generation) content.removeAttribute('aria-busy');
  }
}

async function refreshSavedState() {
  const generation=state.generation,mode=state.mode,epoch=state.mutationEpoch;
  if(checkoutId) {
    const {order}=await api(`checkout/${checkoutId}`);
    if(epoch===state.mutationEpoch)acceptOrder(order);
    return;
  }
  const [{invoices},{payments},{orders}]=await Promise.all([api('invoices?mode='+mode),api('payments?mode='+mode),api('orders?mode='+mode)]);
  if(mode!==state.mode||generation!==state.generation||epoch!==state.mutationEpoch)return;
  const previous=activeOrder();
  const invoiceChanged=JSON.stringify(state.invoices)!==JSON.stringify(invoices),paymentChanged=JSON.stringify(state.payments)!==JSON.stringify(payments),orderChanged=JSON.stringify(state.orders)!==JSON.stringify(orders);
  state.invoices=invoices;state.payments=payments;state.orders=orders;
  if(invoiceChanged||paymentChanged)updateInvoices();
  if(orderChanged){renderTable();updateSummary();}
  if(paymentChanged||invoiceChanged)renderRecovery();
  if(JSON.stringify(previous)!==JSON.stringify(activeOrder()))renderActive();
  validateAllocationPreview();
}

function acceptOrder(order) {
  order=rememberSavedOrder(order);
  if (checkoutId) {
    if (JSON.stringify(state.checkout) !== JSON.stringify(order)) renderCheckout(order);
    return;
  }
  if (order.mode !== state.mode) return;
  if (order.invoice) {
    const index = state.invoices.findIndex(candidate => candidate.id === order.id);
    const previous = state.invoices[index];
    if (index === -1) state.invoices.unshift(order);
    else {
      if (JSON.stringify(state.invoices[index]) === JSON.stringify(order)) return;
      state.invoices[index] = order;
    }
    updateInvoices();
    if (currentView() === 'invoices' && order.id === state.invoiceSelected) {
      renderActive({ settled: Boolean(previous) && previous.status !== 'paid' && order.status === 'paid' });
    }
    return;
  }
  const index = state.orders.findIndex(candidate => candidate.id === order.id);
  const previous = state.orders[index];
  if (index === -1) state.orders.unshift(order);
  else {
    if (JSON.stringify(state.orders[index]) === JSON.stringify(order)) return;
    state.orders[index] = order;
  }
  renderTable();
  updateSummary();
  if (order.id === state.selected) {
    renderActive({ settled: Boolean(previous) && previous.status !== 'paid' && order.status === 'paid' });
  }
}

async function checkPayment({ signature, quiet = false } = {}) {
  const order = checkoutId ? state.checkout : activeOrder();
  if (!order || state.checking) return;
  state.checking = true;
  const button = $('[data-action="check"]');
  if (quiet) { if (button) button.disabled = true; }
  else setButtonBusy(button, true, 'Checking…');
  try {
    const mode=state.mode,generation=state.generation;
    let result;
    if(signature!==undefined&&order.invoice) {
      result=await api('payments/verify',{invoice_id:order.id,signature});
      if(generation!==state.generation||(!checkoutId&&mode!==state.mode))return;
      if(checkoutId)acceptOrder(result.invoice);else acceptOrder((await api(`orders/${order.id}`)).order);
      result.note={unallocated:'Transfer verified. It awaits merchant allocation and does not reduce the balance yet. Wait before paying again.',allocated:'Verified payment allocated. Invoice refreshed.',pending:'Not found at finalized commitment. Keep this signature and retry.'}[result.outcome];
    } else {
      result=await api(`${checkoutId?'checkout':'orders'}/${order.id}/check`,signature===undefined?{}:{signature});
      if(generation!==state.generation||(!checkoutId&&mode!==state.mode))return;
      acceptOrder(result.order);
    }
    const current = checkoutId ? state.checkout : activeOrder();
    const note = $('#payment-note');
    if (current?.id === order.id && note) {
      note.textContent = quiet && result.note === 'Checked finalized Devnet activity.' ? '' : result.note;
    }
  } catch (error) {
    const current = checkoutId ? state.checkout : activeOrder();
    const note = $('#payment-note');
    if (current?.id === order.id && note) note.textContent = error.message;
  } finally {
    state.checking = false;
    if (quiet) { if (button) button.disabled = false; }
    else setButtonBusy(button, false);
  }
}

const presets = { coffee: ['Iced coffee', '4.00'], cookies: ['Bake sale box', '6.50'], raffle: ['Raffle ticket', '5.00'] };

content.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  const data = new FormData(form);
  if (form.id === 'signature-form') {
    const submit = $('button', form);
    setButtonBusy(submit, true, 'Verifying…');
    await checkPayment({ signature: data.get('signature') });
    setButtonBusy(submit, false);
    return;
  }
  if (form.id === 'invoice-import') {
    const button = $('button[type="submit"]', form);
    const errorText = $('#import-error');
    const mode = state.mode;
    setButtonBusy(button, true, 'Importing…');
    errorText.textContent = '';
    try {
      const file = data.get('file');
      if (!file?.size || file.size > 48_000) throw new Error('Choose a CSV file smaller than 48 KB.');
      const result = await api('invoices/import', { mode, csv: await file.text() });
      form.closest('dialog')?.close();
      if (state.mode === mode) await loadWorkspace();
      flash(`Imported ${result.created}. Skipped ${result.skipped} identical invoices.`);
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      setButtonBusy(button, false);
    }
    return;
  }
  if (form.id === 'invoice-form') {
    const button = $('button[type="submit"]', form);
    const errorText = $('#invoice-error');
    const mode = state.mode;
    const generation=state.generation,selected=state.invoiceSelected;
    const fields = Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value).trim()]));
    const key = JSON.stringify(['invoice', mode, fields]);
    if (state.requestDraft?.key !== key) state.requestDraft = { key, id: crypto.randomUUID() };
    const draft=state.requestDraft;
    setButtonBusy(button, true, 'Creating invoice…');
    errorText.textContent = '';
    try {
      const { order } = await api('invoices', { ...fields, id: draft.id, mode });
      if(state.requestDraft===draft)state.requestDraft=null;
      if (state.mode === mode && generation===state.generation && currentView() === 'invoices' && selected===state.invoiceSelected) {
        state.invoiceSelected = order.id;
        sessionStorage.setItem('boothproof-selected-invoice-'+mode,order.id);
        acceptOrder(order);
        renderActive();
        form.reset();
        form.closest('dialog')?.close();
        $('#payment-desk')?.focus({ preventScroll: true });
        if (matchMedia('(max-width: 760px)').matches) $('#payment-desk')?.scrollIntoView({ block: 'start' });
        flash('Invoice created.');
      }
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      setButtonBusy(button, false);
    }
    return;
  }
  if (form.id !== 'checkout-form') return;
  const button = $('button[type="submit"]', form);
  const errorText = $('#create-error');
  const amount = data.get('amount').trim();
  const title = data.get('title').trim();
  const mode = state.mode;
  const generation=state.generation;
  const key = JSON.stringify([mode, title, amount]);
  if (state.requestDraft?.key !== key) state.requestDraft = { key, id: crypto.randomUUID() };
  const draft=state.requestDraft;
  setButtonBusy(button, true, 'Creating request…');
  errorText.textContent = '';
  try {
    const { order } = await api('orders', { id: draft.id, mode, title, amount });
    if(state.requestDraft===draft)state.requestDraft=null;
    if (state.mode === mode && generation===state.generation) {
      state.selected = order.id;
      acceptOrder(order);
      form.reset();
      $('#payment-desk')?.focus({ preventScroll: true });
      if (matchMedia('(max-width: 760px)').matches) $('#payment-desk')?.scrollIntoView({ block: 'start' });
      flash('Payment request created.');
    }
  } catch (error) {
    errorText.textContent = error.message;
  } finally {
    setButtonBusy(button, false);
  }
});

function reachInvoiceDesk() {
  const desk=$('#payment-desk');if(!desk)return;
  desk.focus({preventScroll:true});const top=desk.getBoundingClientRect().top;
  if(matchMedia('(max-width: 900px)').matches||top<80||top>innerHeight-200)desk.scrollIntoView({block:'start'});
}
function selectInvoice(id) {
  state.invoiceSelected=id;sessionStorage.setItem('boothproof-selected-invoice-'+state.mode,id);
  renderActive();updateInvoices();
}
content.addEventListener('change',event=>{if(event.target.id==='invoice-picker')selectInvoice(event.target.value);});
content.addEventListener('click',event=>{if(event.target.closest('a[href="#recovery"]')){state.recoveryInvoice=null;state.recoveryFilter='unallocated';}});
content.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const { select, preset, filter, copy, scenario, action, invoiceFilter,allocate,reverse,review,reviewAction,recoveryFilter,attention,paymentOption,checkoutPay } = button.dataset;
  if(button.dataset.compose){const dialog=$('#invoice-'+(button.dataset.compose==='create'?'create':'import')+'-dialog');dialog?.showModal();$('input',dialog??content)?.focus();return;}
  if(button.hasAttribute('data-close-compose')){button.closest('dialog')?.close();return;}
  if(button.hasAttribute('data-reach-invoice')){reachInvoiceDesk();return;}
  if(button.hasAttribute('data-clear-recovery')){state.recoveryInvoice=null;renderRecovery();return;}
  if(button.dataset.inspectRecovery){state.recoveryInvoice=button.dataset.inspectRecovery;state.recoveryFilter='unallocated';location.hash='recovery';return;}
  if(button.hasAttribute('data-review-queue')){state.invoiceFilter='review';const first=state.invoices.find(o=>o.invoice.issues);if(first)selectInvoice(first.id);else updateInvoices();reachInvoiceDesk();return;}
  if(allocate) return allocationDialog(allocate);
  if(reverse) return reverseDialog(reverse);
  if(review) return reviewDialog(review,reviewAction);
  if(recoveryFilter) {state.recoveryFilter=recoveryFilter;renderWorkspace();return;}
  if(attention) {selectInvoice(attention);const review=$('.review-list');review?.focus({preventScroll:true});review?.scrollIntoView({block:'nearest'});return;}
  if (paymentOption) {
    const order = state.checkout;
    if (!order?.invoice || order.id !== checkoutId) return;
    const selection = { invoiceId: order.id, button };
    const isLatest = () => state.paymentOptionSelection === selection && state.checkout?.id === selection.invoiceId;
    setButtonBusy(state.paymentOptionSelection?.button, false);
    state.paymentOptionSelection = selection;
    setButtonBusy(button, true, 'Updating…');
    try {
      const result = await api(`invoices/${selection.invoiceId}/payment-request`, { option: paymentOption });
      if (!isLatest()) return;
      if (result.stale) {
        state.checkoutRequest = null;
        renderCheckout(result.invoice);
        flash('The balance changed. Choose a current payment amount.', true);
        return;
      }
      state.checkoutRequest = { id: selection.invoiceId, ...result };
      renderCheckout(result.invoice);
    } catch (error) {
      if (!isLatest()) return;
      if (error.body?.invoice) renderCheckout(error.body.invoice);
      flash(error.message, true);
    } finally {
      if (isLatest()) {
        state.paymentOptionSelection = null;
        setButtonBusy(button, false);
      }
    }
    return;
  }
  if(checkoutPay) {
    const order=state.checkout;if(!order)return;setButtonBusy(button,true,'Simulating…');
    try{acceptOrder((await api(`checkout/${order.id}/simulate`,{option:checkoutPay})).order);flash('Simulated payment saved.');}
    catch(error){if(error.body?.invoice)renderCheckout(error.body.invoice);flash(error.message,true);}
    finally{setButtonBusy(button,false);}return;
  }
  if (preset) {
    const form = $('#checkout-form');
    const [title, amount] = presets[preset];
    form.elements.title.value = title;
    form.elements.amount.value = amount;
    form.elements.amount.focus();
  } else if (select) {
    if (currentView() === 'invoices') {
      selectInvoice(select);reachInvoiceDesk();
      return;
    }
    state.selected = select;
    if (currentView() === 'ledger') {
      state.jumpToDesk = true;
      location.hash = 'booth';
      return;
    }
    renderActive();
    renderTable();
    $('#payment-desk')?.focus({ preventScroll: true });
    $('#payment-desk')?.scrollIntoView({ block: 'nearest' });
  } else if (filter) {
    state.filter = filter;
    $('.filters').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    renderTable();
    revealRows($('#orders'));
  } else if (invoiceFilter) {
    state.invoiceFilter = invoiceFilter;
    document.querySelectorAll('[data-invoice-filter]').forEach(item =>
      item.setAttribute('aria-pressed', String(item === button))
    );
    updateInvoices();
    revealRows($('#invoice-register'));
  } else if (copy) {
    try {
      await navigator.clipboard.writeText(copy);
      flash('Copied to clipboard.');
    } catch {
      flash('Clipboard unavailable. Open the checkout to copy its address.', true);
    }
  } else if (scenario) {
    const order = checkoutId ? state.checkout : activeOrder();
    if (!order) return;
    setButtonBusy(button, true, 'Recording…');
    try {
      const result = await api(`orders/${order.id}/simulate`, { scenario });
      acceptOrder(result.order);
      await refreshSavedState();
      flash(result.order.status === 'paid' && scenario === 'exact' ? 'Demo receipt verified.' : 'Demo payment recorded.');
    } catch (error) {
      flash(error.message, true);
    } finally {
      setButtonBusy(button, false);
    }
  } else if (action === 'check') {
    await checkPayment();
  } else if (action === 'print') {
    window.print();
  } else if (action === 'reload') {
    location.reload();
  }
});

modeSelect.addEventListener('change', () => {
  if(decisionDialog.open)decisionDialog.close();
  state.mode = modeSelect.value;
  state.selected = null;
  state.invoiceSelected = null;
  state.payments=[];
  state.filter = 'all';
  state.invoiceFilter = 'all';
  sessionStorage.setItem('boothproof-mode', state.mode);
  void loadWorkspace();
});
$('#navigation').addEventListener('click',event=>{if(event.target.closest('[data-view="recovery"]')){state.recoveryInvoice=null;if(currentView()==='recovery')renderRecovery();}});

window.addEventListener('hashchange', () => {
  if (!checkoutId && state.config && location.hash !== '#content') {
    renderWorkspace();
    if (state.jumpToDesk) {
      state.jumpToDesk = false;
      $('#payment-desk')?.focus({ preventScroll: true });
      $('#payment-desk')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    content.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
});
$('.skip').addEventListener('click',event=>{event.preventDefault();content.focus({preventScroll:true});content.scrollIntoView({block:'start'});});

if (checkoutId) {
  $('#navigation').hidden = true;
  $('#mode-control').hidden = true;
  api(`checkout/${checkoutId}`).then(({ order, wallet_review }) => {
    state.walletReview = wallet_review;
    if (wallet_review?.replay) modeNames.devnet = 'Devnet receipt replay';
    renderCheckout(order);
  }).catch(error =>
    messagePage('Checkout unavailable.', error.message)
  ).finally(() => content.removeAttribute('aria-busy'));
} else {
  if(!location.hash)history.replaceState(null,'','#invoices');
  void loadWorkspace();
}

let polling = false;
setInterval(async () => {
  if (document.hidden || polling || content.hasAttribute('aria-busy')) return;
  polling = true;
  try {
    await refreshSavedState();
  } catch {
    // Explicit actions display connection errors and remain available.
  } finally {
    polling = false;
  }
}, 5_000);
