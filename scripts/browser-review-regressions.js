async page => {
  const base='http://127.0.0.1:4174';await page.setViewportSize({width:1366,height:900});await page.goto(base);await page.emulateMedia({reducedMotion:'reduce'});
  const id=await page.evaluate(()=>crypto.randomUUID());
  const created=await page.request.post(base+'/api/invoices',{data:{id,mode:'demo',invoice_number:'RACE-'+Date.now(),
    client:'Browser regression',title:'Delayed checkout response',amount:'50.00',deposit_amount:'30.00',due_date:'2026-12-01'}});
  if(created.status()!==201)throw new Error('Could not create isolated checkout fixture.');
  await page.goto(base+'/pay/'+id);await page.locator('.customer-amount').filter({hasText:'50.00'}).waitFor();
  let release,seen;
  const held=new Promise(resolve=>release=resolve),captured=new Promise(resolve=>seen=resolve);
  let capturedOnce=false;
  await page.route('**/api/checkout/'+id,async route=>{
    if(capturedOnce||route.request().method()!=='GET'){await route.continue();return;}
    capturedOnce=true;const response=await route.fetch(),body=await response.text();seen();await held;
    await route.fulfill({response,body});
  });
  await captured;
  await page.getByRole('button',{name:'Simulate remaining balance',exact:true}).click();
  await page.locator('.customer-amount').filter({hasText:/^0[.]00/}).waitFor();
  release();await page.waitForTimeout(350);
  const remaining=await page.locator('.customer-amount').innerText();
  if(!remaining.startsWith('0.00')||await page.getByRole('button',{name:'Simulate remaining balance',exact:true}).count()) {
    throw new Error('Stale polling response restored the unsettled balance: '+remaining);
  }
  await page.unroute('**/api/checkout/'+id);
  const create=async (title,mode='demo')=>{
    const id=await page.evaluate(()=>crypto.randomUUID()),invoice_number='REVIEW-'+Date.now()+'-'+id.slice(0,5);
    const response=await page.request.post(base+'/api/invoices',{data:{id,invoice_number,mode,client:'Review studio',title,amount:'50.00',deposit_amount:'30.00',due_date:'2026-12-01'}});
    if(response.status()!==201)throw new Error('Could not prepare review fixture.');return (await response.json()).order;
  };
  const requestRace=await create('Delayed payment option');await page.goto(base+'/pay/'+requestRace.id);
  let releaseOption,optionSeen;
  const heldOption=new Promise(resolve=>releaseOption=resolve),sawOption=new Promise(resolve=>optionSeen=resolve);
  await page.route('**/api/invoices/'+requestRace.id+'/payment-request',async route=>{
    const response=await route.fetch();optionSeen();await heldOption;await route.fulfill({response});
  });
  await page.getByRole('button',{name:/^Pay deposit/}).click();await sawOption;
  await page.getByRole('button',{name:'Simulate remaining balance',exact:true}).click();
  await page.locator('.customer-amount').filter({hasText:/^0[.]00/}).waitFor();releaseOption();await page.waitForTimeout(250);
  if(!(await page.locator('.customer-amount').innerText()).startsWith('0.00')||await page.locator('[data-checkout-pay]').count())throw new Error('An old payment option restored settled controls.');
  await page.unroute('**/api/invoices/'+requestRace.id+'/payment-request');

  async function paymentOptionRace(older, latest, { failOlder = false, finishOlderFirst = false } = {}) {
    const order = await create('Out-of-order payment options', 'devnet');
    const checkout = await page.context().newPage();
    const options = {
      [older]: { captured: Promise.withResolvers(), release: Promise.withResolvers() },
      [latest]: { captured: Promise.withResolvers(), release: Promise.withResolvers() }
    };
    const obsoleteError = 'Obsolete payment option failed.';
    const button = option => checkout.locator(`[data-payment-option="${option}"]`);
    const consumed = count => checkout.waitForFunction(expected => window.paymentOptionsConsumed === expected, count);
    async function assertLatest() {
      const selected = await checkout.locator('[data-payment-option][aria-pressed="true"]').evaluateAll(buttons =>
        buttons.map(element => element.dataset.paymentOption));
      const request = await checkout.locator('.customer-help').innerText();
      const url = await checkout.getByRole('link', { name: 'Open in wallet', exact: true }).getAttribute('href');
      const amount = latest === 'deposit' ? '30.00' : '50.00';
      if (selected.length !== 1 || selected[0] !== latest || !request.startsWith(`Selected request: ${amount} USDC.`) ||
          new URL(url).searchParams.get('amount') !== amount) {
        throw new Error(`Expected ${latest} at ${amount} USDC, got ${JSON.stringify({ selected, request, url })}`);
      }
    }

    try {
      await checkout.addInitScript(() => {
        window.paymentOptionsConsumed = 0;
        const json = Response.prototype.json;
        Response.prototype.json = function () {
          const body = json.call(this);
          // The next task runs after checkout has processed the parsed response.
          if (this.url.endsWith('/payment-request')) body.then(() => setTimeout(() => window.paymentOptionsConsumed++, 0));
          return body;
        };
      });
      await checkout.route(`**/api/invoices/${order.id}/payment-request`, async route => {
        const { option } = route.request().postDataJSON();
        const control = options[option];
        const response = await route.fetch();
        control.captured.resolve();
        await control.release.promise;
        if (failOlder && option === older) {
          const { invoice } = await response.json();
          await route.fulfill({ status: 409, json: { error: obsoleteError, invoice } });
        } else {
          await route.fulfill({ response });
        }
      });
      await checkout.goto(`${base}/pay/${order.id}`);
      await button(older).click();
      await options[older].captured.promise;
      await button(latest).click();
      await options[latest].captured.promise;

      const first = finishOlderFirst ? older : latest;
      options[first].release.resolve();
      await consumed(1);
      if (finishOlderFirst) {
        if (await button(latest).getAttribute('aria-busy') !== 'true' || !await button(latest).isDisabled()) {
          throw new Error('An obsolete response cleared the latest loading state.');
        }
      } else {
        await assertLatest();
      }

      options[first === older ? latest : older].release.resolve();
      await consumed(2);
      await assertLatest();
      if ((await checkout.locator('#notice').textContent()).includes(obsoleteError)) {
        throw new Error('An obsolete error was displayed over the latest selection.');
      }
      if (!await button(older).isEnabled() || !await button(latest).isEnabled()) throw new Error('A completed selection left a button busy.');
    } finally {
      for (const control of Object.values(options)) control.release.resolve();
      await checkout.unrouteAll({ behavior: 'wait' });
      await checkout.close();
    }
  }

  const selectionFailures = [];
  for (const [label, older, latest, options] of [
    ['Delayed deposit', 'deposit', 'balance'],
    ['Delayed balance', 'balance', 'deposit'],
    ['Delayed failure', 'deposit', 'balance', { failOlder: true }],
    ['Latest loading state', 'balance', 'deposit', { finishOlderFirst: true }]
  ]) {
    try { await paymentOptionRace(older, latest, options); }
    catch (error) { selectionFailures.push(`${label}: ${error.message}`); }
  }
  if (selectionFailures.length) throw new Error(selectionFailures.join('\n'));

  const target=await create('Assignment revision preview');
  const practice=await page.request.post(base+'/api/orders/'+target.id+'/simulate',{data:{scenario:'recovery'}});
  const {signature}=await practice.json();await page.goto(base+'/#recovery');
  const article=page.locator('.recovered-payment').filter({hasText:target.invoice.invoice_number});
  await article.getByRole('button',{name:'Assign to invoice'}).click();
  const dialog=page.locator('dialog.decision-dialog'),form=dialog.locator('#allocation-form');
  await form.locator('select').selectOption({label:target.invoice.invoice_number+' · Review studio'});
  const note='Keep this decision note while balances change';await form.locator('textarea').fill(note);
  await page.request.post(base+'/api/orders/'+target.id+'/simulate',{data:{scenario:'partial'}});
  await form.locator('[data-preview-stale]').filter({hasText:'changed'}).waitFor({timeout:12_000});
  if(await form.getByRole('button',{name:'Confirm assignment',exact:true}).isEnabled())throw new Error('Stale assignment confirmation stayed enabled.');
  if(await form.locator('textarea').inputValue()!==note)throw new Error('Preview invalidation erased its note.');
  await form.locator('textarea').fill(note+' edited');await form.locator('textarea').press('Tab');
  if(await form.getByRole('button',{name:'Confirm assignment',exact:true}).isEnabled())throw new Error('Leaving the note silently renewed an obsolete preview.');
  await form.getByRole('button',{name:'Refresh preview',exact:true}).click();
  const preview=await form.locator('#allocation-preview').innerText();
  if(!preview.includes('60.00 USDC')||!preview.includes('10.00 USDC'))throw new Error('Renewed preview omitted the resulting excess.');
  await form.getByRole('button',{name:'Confirm assignment',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const reportA=await create('Reported payment A'),reportB=await create('Reported payment B');
  const reported=await (await page.request.post(base+'/api/orders/'+reportA.id+'/simulate',{data:{scenario:'recovery'}})).json();
  await page.goto(base+'/pay/'+reportB.id);await page.getByText('I already paid',{exact:true}).click();
  await page.locator('#signature').fill(reported.signature);await page.getByRole('button',{name:'Verify',exact:true}).click();
  await page.locator('#payment-note').filter({hasText:'reported for a different invoice'}).waitFor();
  await page.reload();await page.locator('.customer-amount').filter({hasText:/^50[.]00/}).waitFor();
  if(await page.getByText('Your reported transfer is verified and awaits merchant allocation.',{exact:false}).count())throw new Error('Another invoice falsely retained an awaiting-allocation report.');
  await page.goto(base+'/#invoices');await page.getByRole('button',{name:'Inspect invoice '+reportA.invoice.invoice_number,exact:true}).click();
  await page.reload();await page.locator('#payment-content .eyebrow').filter({hasText:reportA.invoice.invoice_number}).waitFor();
  const visible=await page.evaluate(()=>{
    const within=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;};
    return {register:within('.invoice-register-panel .table-head'),identity:within('.payment-heading'),totals:within('#payment-content .invoice-balances'),signature:within('#signature-form'),recovery:within('[data-inspect-recovery]'),deskFraction:document.querySelector('#payment-desk').getBoundingClientRect().width/document.querySelector('.invoice-workspace').getBoundingClientRect().width};
  });
  if(!visible.register||!visible.identity||!visible.totals||!visible.signature||!visible.recovery||visible.deskFraction<0.55||visible.deskFraction>0.65)throw new Error('The first desktop viewport hides the work: '+JSON.stringify(visible));
  await page.screenshot({path:'output/playwright/workspace-focused-desktop.png'});
  const newInvoice=page.getByRole('button',{name:'New invoice',exact:true});await newInvoice.focus();await newInvoice.press('Enter');
  const compose=page.locator('#invoice-create-dialog');await compose.locator('[name="client"]').fill('Draft survives refresh');
  await page.waitForTimeout(5300);if(await compose.locator('[name="client"]').inputValue()!=='Draft survives refresh')throw new Error('Polling erased an invoice draft.');
  await page.keyboard.press('Escape');if(!await newInvoice.evaluate(el=>el===document.activeElement))throw new Error('Dialog close lost launcher focus.');
  await page.setViewportSize({width:360,height:800});await page.screenshot({path:'output/playwright/workspace-focused-mobile-register.png'});
  await page.locator('#invoice-picker').selectOption(reportA.id);await page.getByRole('button',{name:'View details',exact:true}).click();
  await page.screenshot({path:'output/playwright/workspace-focused-mobile-desk.png'});
  if(!await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))throw new Error('The 360px workspace overflows the page.');
  await page.locator('#signature').fill(reported.signature);await page.locator('#signature').focus();await page.waitForTimeout(5300);
  if(await page.locator('#signature').inputValue()!==reported.signature||!await page.evaluate(()=>document.activeElement.id==='signature'))throw new Error('Mobile polling lost the signature draft or focus.');
  await page.setViewportSize({width:1366,height:900});
  return {staleCheckoutResponseRejected:true,stalePaymentOptionRejected:true,latestPaymentOptionWins:true,obsoletePaymentOptionErrorIgnored:true,latestPaymentOptionLoadingPreserved:true,stalePreviewRequiresRenewedConfirmation:true,reportConflictSurvivesReload:true,
    desktopFirstViewport:visible,mobileOverflow:false,dialogAndDraftChecks:true};
}
