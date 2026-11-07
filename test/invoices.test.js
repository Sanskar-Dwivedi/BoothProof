import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceCsv, reconcileInvoice, validateInvoice } from '../server/invoices.js';
import { paymentUrl } from '../server/solana.js';
import { DEMO_RECIPIENT } from '../server/fixtures.js';

const invoice = { invoice_number: 'INV-001', client: 'Northstar Studio', due_date: '2026-11-01' };
const credit = (signature, amount, kind = 'amount') => ({
  signature, amount, kind, observed_at: '2026-11-05T09:00:00.000Z'
});

test('invoice reconciliation adds legitimate partial credits, deduces outstanding and overpayment, and excludes wrong tokens', () => {
  const entries = [credit('a', '30000000'), credit('b', '50000000', 'mint')];
  const partial = reconcileInvoice(invoice, 50_000_000, entries, '2026-11-05');
  assert.equal(partial.state, 'partial');
  assert.equal(partial.remaining_units, '20000000');
  assert.equal(partial.received_units, '30000000');
  assert.equal(partial.issues, 1);
  assert.equal(partial.overdue, true);
  entries.push(credit('c', '20000000'));
  const paid = reconcileInvoice(invoice, 50_000_000, entries, '2026-11-05');
  assert.equal(paid.state, 'paid');
  assert.equal(paid.credit_count, 2);
  assert.equal(paid.overdue, false);
  entries.push(credit('d', '1000000'));
  const overpaid = reconcileInvoice(invoice, 50_000_000, entries, '2026-11-05');
  assert.equal(overpaid.state, 'overpaid');
  assert.equal(overpaid.overpaid_units, '1000000');
  assert.equal(overpaid.remaining_units, '0');
});

test('remaining payment links retain six-decimal precision', () => {
  const url = new URL(paymentUrl({
    recipient: DEMO_RECIPIENT, reference: DEMO_RECIPIENT, title: 'Invoice balance', amount_units: '19999999'
  }));
  assert.equal(url.searchParams.get('amount'), '19.999999');
});

test('CSV supports BOM, escaped commas and quotes, reordered columns, and CRLF', () => {
  const csv = '\uFEFF"client",invoice_number,title,due_date,amount\r\n"Northstar, Studio",INV-001,"Design ""final""",2026-11-30,50.00\r\n';
  const [parsed] = parseInvoiceCsv(csv);
  assert.equal(parsed.client, 'Northstar, Studio');
  assert.equal(parsed.title, 'Design "final"');
  assert.equal(parsed.amount, 50_000_000);
});

test('CSV and invoice validation reject invalid dates, duplicate numbers and malformed rows', () => {
  const header = 'invoice_number,client,title,amount,due_date\n';
  const row = 'INV-001,Northstar Studio,Design,50.00,2026-11-30\n';
  assert.throws(() => parseInvoiceCsv(header + row + row), /unique/);
  assert.throws(() => parseInvoiceCsv(header + '"unterminated'), /quoting/);
  assert.throws(() => parseInvoiceCsv(header + 'INV-001,Client,Design,50.00'), /five fields/);
  assert.throws(() => validateInvoice({ ...invoice, title: 'Design', amount: '50.00', due_date: '2026-02-30' }), /due date/);
});
