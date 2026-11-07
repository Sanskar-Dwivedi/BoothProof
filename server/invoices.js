import { parseAmount } from './solana.js';

export class InvoiceError extends Error {
  constructor(message, status = 400, code = 'INVALID_INVOICE') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function calendarDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function validateInvoice(input) {
  const text = (key, limit) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!value || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new InvoiceError(`Enter a valid ${key.replaceAll('_', ' ')} of at most ${limit} characters.`);
    }
    return value;
  };
  const invoice_number = text('invoice_number', 30);
  const client = text('client', 60);
  const title = text('title', 60);
  const amount = parseAmount(input.amount);
  if (amount === null) throw new InvoiceError('Enter an invoice amount from 0.01 to 9,999.99 USDC.');
  let deposit_units = null;
  if (input.deposit_amount !== undefined && input.deposit_amount !== null && input.deposit_amount !== '') {
    deposit_units = parseAmount(input.deposit_amount);
    if (deposit_units === null || BigInt(deposit_units) >= BigInt(amount)) {
      throw new InvoiceError('The deposit must be positive and below the invoice total, with at most two decimal places.');
    }
  }
  const due_date = input.due_date;
  if (typeof due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due_date) ||
      !Number.isFinite(Date.parse(due_date)) || new Date(due_date).toISOString().slice(0, 10) !== due_date) {
    throw new InvoiceError('Enter a valid due date in YYYY-MM-DD format.');
  }
  return { invoice_number, number_key: invoice_number.toUpperCase(), client, title, amount, due_date, deposit_units };
}

export function reconcileInvoice(invoice, amountUnits, entries, today = calendarDate()) {
  const credits = entries.filter(entry => entry.kind === 'exact' || entry.kind === 'amount');
  const received = credits.reduce((total, entry) => total + BigInt(entry.amount), 0n);
  const expected = BigInt(amountUnits);
  const remaining = received < expected ? expected - received : 0n;
  const excess = received > expected ? received - expected : 0n;
  let status = 'unpaid';
  if (received > 0n) status = 'partial';
  if (received === expected) status = 'paid';
  if (excess > 0n) status = 'overpaid';
  return {
    ...invoice, state: status,
    expected_units: expected.toString(), excess_units: excess.toString(),
    deposit_units: invoice.deposit_units == null ? null : String(invoice.deposit_units),
    deposit_remaining_units: invoice.deposit_units == null ? '0' :
      (received < BigInt(invoice.deposit_units) ? BigInt(invoice.deposit_units) - received : 0n).toString(),
    received_units: received.toString(), remaining_units: remaining.toString(),
    overpaid_units: excess.toString(), credit_count: credits.length,
    issues: entries.length - credits.length + (excess > 0n ? 1 : 0),
    overdue: remaining > 0n && invoice.due_date < today,
    settled_at: status === 'paid' ? credits.at(-1).observed_at : null
  };
}

export function parseInvoiceCsv(source) {
  if (typeof source !== 'string' || !source.trim()) throw new InvoiceError('Choose a CSV file with invoice rows.');
  source = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const invalid = () => new InvoiceError('The CSV has invalid quoting. Use the downloadable CSV example.');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else field += character;
    } else if (character === '"') {
      if (field || closedQuote) throw invalid();
      quoted = true;
    } else if (character === ',' || character === '\r' || character === '\n') {
      row.push(field);
      field = '';
      closedQuote = false;
      if (character !== ',') {
        rows.push(row);
        row = [];
        if (character === '\r' && source[index + 1] === '\n') index++;
      }
    } else {
      if (closedQuote) throw invalid();
      field += character;
    }
  }
  if (quoted) throw invalid();
  if (field || closedQuote || row.length) rows.push([...row, field]);
  const header = rows.shift()?.map(value => value.trim().toLowerCase().replace(/^\uFEFF/, ''));
  const required = ['invoice_number', 'client', 'title', 'amount', 'due_date'];
  if (header?.length !== required.length || new Set(header).size !== required.length ||
      required.some(key => !header.includes(key))) {
    throw new InvoiceError('CSV columns must be invoice_number, client, title, amount, due_date.');
  }
  const items = rows.filter(fields => fields.some(value => value.trim()));
  if (!items.length || items.length > 100) throw new InvoiceError('Import between 1 and 100 invoices at a time.');
  const seen = new Set();
  return items.map((fields, index) => {
    try {
      if (fields.length !== header.length) throw new InvoiceError('Each row needs five fields.');
      const invoice = validateInvoice(Object.fromEntries(header.map((key, column) => [key, fields[column]])));
      if (seen.has(invoice.number_key)) throw new InvoiceError('Invoice numbers must be unique within this CSV.');
      seen.add(invoice.number_key);
      return invoice;
    } catch (error) {
      throw new InvoiceError(`Row ${index + 2}: ${error.message}`);
    }
  });
}
