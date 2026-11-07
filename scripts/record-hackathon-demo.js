// Run once in a fresh hackathon replay workspace while Playwright video recording is active.
async page => {
  const base = 'http://127.0.0.1:4180';
  const wallet = 'http://127.0.0.1:4181';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.context().grantPermissions(['clipboard-write'], { origin: wallet });
  await page.goto(`${base}/#invoices`);
  await page.getByLabel('Payment workspace').selectOption('devnet');
  const openCheckout = page.getByRole('link', { name: 'Open checkout', exact: true });
  await openCheckout.waitFor();
  const checkout = new URL(await openCheckout.getAttribute('href'), base);
  const id = checkout.pathname.split('/').at(-1);
  const readCheckout = async () => (await (await page.request.get(`${base}/api/checkout/${id}`)).json());
  const initial = await readCheckout();
  if (!initial.wallet_review?.replay || initial.order.invoice.received_units !== '0' || initial.order.invoice.remaining_units !== '50000000') {
    throw new Error('Start with a fresh isolated Devnet receipt replay.');
  }
  const number = initial.order.invoice.invoice_number;
  const reference = new URL(initial.order.payment_url).searchParams.get('reference');
  const top = () => page.evaluate(() => scrollTo(0, 0));

  async function reviewReceipt(link, amount, expectedReference) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await page.getByRole('heading', { name: 'Phantom review · recorded payment' }).waitFor();
    const proof = await (await page.request.get(`${wallet}/api/payment`)).json();
    if (new URL(page.url()).origin !== wallet || !proof.replay || proof.amount_units !== amount ||
        proof.reference !== expectedReference || !await page.locator('#review').isHidden()) {
      throw new Error('Checkout opened the wrong wallet review.');
    }
    const signature = await page.locator('#signature').innerText();
    await page.getByRole('button', { name: 'Copy signature', exact: true }).click();
    await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    if (expectedReference) await page.screenshot({ path: 'output/playwright/hackathon-phantom-handoff.png' });
    await page.waitForTimeout(3_400);
    await page.getByRole('link', { name: /Customer statement/ }).click();
    return signature;
  }

  async function verifySignature(signature, outcome) {
    const form = page.locator('#signature-form');
    const input = form.locator('#signature');
    if (!await input.isVisible()) await page.getByText('I already paid', { exact: true }).click();
    await input.fill(signature);
    const response = page.waitForResponse(reply => reply.url() === `${base}/api/payments/verify` && reply.request().method() === 'POST');
    await form.getByRole('button', { name: 'Verify', exact: true }).click();
    const reply = await response;
    const result = await reply.json();
    if (!reply.ok() || result.outcome !== outcome || result.signature !== signature) throw new Error('Devnet receipt verification failed.');
  }

  await top();
  await page.waitForTimeout(3_000);
  await openCheckout.click();
  const direct = await reviewReceipt('Review recorded 30 USDC', '30000000', null);
  await verifySignature(direct, 'unallocated');
  await page.getByText(/Your reported transfer is verified and awaits merchant allocation/).waitFor();
  const pending = (await readCheckout()).order;
  if (pending.invoice.received_units !== '0' || pending.invoice.remaining_units !== '50000000' || pending.recovery.payments[0]?.signature !== direct) {
    throw new Error('Unallocated verification changed the invoice credit.');
  }
  await top();
  await page.waitForTimeout(4_000);

  await page.getByRole('link', { name: /Back to invoices/ }).click();
  await page.getByRole('button', { name: 'Inspect recovery report' }).click();
  await page.locator('.recovered-payment').filter({ hasText: number }).getByRole('button', { name: 'Assign to invoice' }).click();
  const dialog = page.locator('dialog.decision-dialog');
  await dialog.locator('select').selectOption(id);
  await dialog.locator('textarea').fill('Receipt replay of the finalized direct transfer.');
  const preview = await dialog.locator('#allocation-preview').innerText();
  if (!preview.includes('30.00 USDC') || !preview.includes('20.00 USDC')) throw new Error('Unexpected assignment preview.');
  await page.waitForTimeout(4_000);
  await dialog.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const assigned = (await readCheckout()).order.invoice;
  if (assigned.received_units !== '30000000' || assigned.remaining_units !== '20000000' || assigned.deposit_remaining_units !== '0') {
    throw new Error('The assignment did not leave the intended 20 USDC balance.');
  }

  await page.getByRole('link', { name: 'Invoices', exact: true }).click();
  await openCheckout.click();
  await page.locator('.customer-amount').filter({ hasText: '20.00 USDC remaining' }).waitFor();
  await page.waitForTimeout(3_000);
  const balance = await reviewReceipt('Review in Phantom · receipt replay', '20000000', reference);
  await verifySignature(balance, 'allocated');
  await page.getByText('Reconciled', { exact: true }).waitFor();
  await top();
  await page.waitForTimeout(4_000);

  const readLedger = async () => {
    const { order } = await (await page.request.get(`${base}/api/orders/${id}`)).json();
    return { invoice: order.invoice, revision: order.revision, payments: order.payments, history: order.timeline };
  };
  const before = await readLedger();
  if (before.invoice.received_units !== '50000000' || before.invoice.remaining_units !== '0' || before.payments.length !== 2 ||
      before.payments[0].signature !== direct || before.payments[0].allocation_method !== 'manual' ||
      before.payments[1].signature !== balance || before.payments[1].allocation_method !== 'reference' ||
      before.payments.some(payment => payment.provenance !== 'rpc')) throw new Error('Unexpected final Devnet proof.');
  for (const signature of [direct, balance]) await verifySignature(signature, 'allocated');
  if (JSON.stringify(await readLedger()) !== JSON.stringify(before)) throw new Error('A signature replay changed the ledger.');
  if (errors.length) throw new Error(errors.join('\n'));
  await top();
  await page.screenshot({ path: 'output/playwright/hackathon-reconciled.png', fullPage: true });
  await page.waitForTimeout(4_000);
  return { kind: 'devnet_receipt_replay', invoice: number, reference, direct, balance, received: '50.00', due: '0.00',
    replays: 2, payments: before.payments.length, auditEvents: before.history.length, pageErrors: errors };
}
