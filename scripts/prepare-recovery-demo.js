async (page) => {
  const number='DEMO-RECOVERY-'+Date.now();
  await page.setViewportSize({width:1366,height:900});await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:4174/#invoices');await page.getByRole('button',{name:'New invoice',exact:true}).click();
  const form=page.locator('#invoice-form');
  for(const [name,value] of Object.entries({invoice_number:number,client:'Northstar Studio',title:'Website design · recovery demo',amount:'50.00',deposit_amount:'30.00',due_date:'2026-12-01'}))await form.locator(`[name="${name}"]`).fill(value);
  await form.getByRole('button',{name:'Create invoice'}).click();await page.getByRole('heading',{name:'Website design · recovery demo'}).waitFor();
  await page.getByText('Practice invoice payments · offline',{exact:true}).click();
  await page.locator('#payment-desk').scrollIntoViewIfNeeded();await page.waitForTimeout(4500);
  return {invoice:number,mode:'Offline Demo; no on-chain transactions'};
}
