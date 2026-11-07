async (page) => {
  // Run after actually stopping and restarting the isolated QA server.
  const checkout=page.url(),id=new URL(checkout).pathname.split('/').at(-1);
  await page.reload();await page.getByText('Reconciled',{exact:true}).waitFor();
  const response=await page.request.get('http://127.0.0.1:4174/api/checkout/'+id),{order}=await response.json();
  if(order.invoice.received_units!=='50000000'||order.payments.length!==2)throw new Error('Restart did not preserve the two-payment statement.');
  const second=order.payments.find(p=>p.amount_units==='20000000');
  if(!second)throw new Error('The referenced balance payment is missing.');
  await page.getByText('I already paid',{exact:true}).click();await page.locator('#signature').fill(second.signature);
  await page.locator('#signature-form').getByRole('button',{name:'Verify',exact:true}).click();
  await page.getByText('Verified payment allocated. Invoice refreshed.',{exact:true}).waitFor();
  await page.locator('.customer-amount').scrollIntoViewIfNeeded();await page.waitForTimeout(3000);
  await page.screenshot({path:'output/playwright/workspace-simulated-restarted-statement.png',fullPage:true});
  return {restart_verified:true,received_units:order.invoice.received_units,remaining_units:order.invoice.remaining_units,payments:order.payments.map(p=>({signature:p.signature,amount_units:p.amount_units,provenance:p.provenance})),mode:'Offline Demo; no Explorer links'};
}
