// Run in a separate Playwright Chrome profile. The mock refuses all signing requests.
async page => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('http://127.0.0.1:4177/');
  await page.getByText('30.00 USDC', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/devnet-phantom-preparation.png' });
  await page.addInitScript(() => {
    const chain = 'solana:devnet';
    const feature = 'solana:signAndSendTransaction';
    const account = {
      address: 'CXhDCE1DUPd91gGTEdWETEhncay7QXdvdsez9LjqaVbq',
      chains: [chain],
      features: [feature]
    };
    window.addEventListener('wallet-standard:app-ready', ({ detail }) => detail.register({
      name: 'Phantom', chains: [chain], accounts: [account], features: {
        'standard:connect': { connect: async () => ({ accounts: [account] }) },
        [feature]: {
          supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: async input => {
            window.mockReview = { chain: input.chain, payer: input.account.address, header: [...input.transaction.slice(65, 69)] };
            throw Object.assign(new Error('Mock wallet declined'), { code: 4001 });
          }
        }
      }
    }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Connect Phantom' }).click();
  await page.getByRole('status').filter({ hasText: 'Payer connected' }).waitFor();
  await page.getByRole('button', { name: 'Review in Phantom' }).click();
  await page.getByRole('status').filter({ hasText: 'Phantom declined the request' }).waitFor();
  const review = await page.evaluate(() => window.mockReview);
  if (review.chain !== 'solana:devnet' || review.header.join(',') !== '1,0,2,5') throw new Error('The wallet received an unexpected transaction.');
  await page.setViewportSize({ width: 360, height: 800 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile overflow.');
  return { mockReview: review, mobileOverflow: false };
}
