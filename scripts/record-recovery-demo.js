async (page) => {
  const number=await page.locator('#payment-content .eyebrow').innerText();
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(1800);
  await page.screenshot({path:'output/playwright/workspace-simulated-demo-start.png'});
  await page.getByRole('button',{name:'Practice reference-free 30 USDC',exact:true}).click();
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(2200);
  await page.getByRole('button',{name:'Inspect recovery report',exact:true}).click();
  const article=page.locator('.recovered-payment').filter({hasText:number});await article.scrollIntoViewIfNeeded();
  const signature=await article.getByRole('button',{name:'Copy signature',exact:true}).getAttribute('data-copy');
  await page.screenshot({path:'output/playwright/workspace-simulated-recovery.png'});await page.waitForTimeout(2200);
  await article.getByRole('button',{name:'Assign to invoice'}).click();
  const dialog=page.locator('dialog.decision-dialog');await dialog.locator('select').selectOption({label:number+' · Northstar Studio'});
  await dialog.locator('textarea').fill('Client confirmed this direct payment belongs to the invoice.');
  await page.waitForTimeout(2600);await page.screenshot({path:'output/playwright/workspace-simulated-allocation-preview.png'});
  await dialog.getByRole('button',{name:'Confirm assignment',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('link',{name:'Invoices',exact:true}).click();await page.getByRole('button',{name:'Inspect invoice '+number,exact:true}).click();
  await page.locator('#payment-desk').scrollIntoViewIfNeeded();await page.waitForTimeout(2200);
  await page.getByRole('link',{name:'Open statement',exact:true}).click();await page.getByRole('button',{name:'Simulate remaining balance',exact:true}).waitFor();
  await page.waitForTimeout(1800);await page.getByRole('button',{name:'Simulate remaining balance',exact:true}).click();await page.getByText('Reconciled',{exact:true}).waitFor();
  await page.waitForTimeout(1600);await page.getByText('I already paid',{exact:true}).click();
  await page.locator('#signature').fill(signature);await page.locator('#signature-form').getByRole('button',{name:'Verify',exact:true}).click();
  await page.getByText('Verified payment allocated. Invoice refreshed.',{exact:true}).waitFor();await page.waitForTimeout(1800);
  return {invoice:number,checkout:page.url(),signature,expected_received_units:'50000000',mode:'Offline Demo'};
}
