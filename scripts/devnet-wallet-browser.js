const chain = 'solana:devnet';
const signFeature = 'solana:signAndSendTransaction';
const connectButton = document.querySelector('#connect');
const reviewButton = document.querySelector('#review');
const refreshPayment = document.querySelector('#refresh-payment');
const copySignature = document.querySelector('#copy-signature');
const status = document.querySelector('#status');
let payment, phantom, attemptKey;

function signingFeature() {
  const feature = phantom?.features?.[signFeature];
  if (!phantom?.chains?.includes(chain) || !feature?.supportedTransactionVersions?.includes('legacy') ||
      typeof feature.signAndSendTransaction !== 'function') {
    throw new Error('Phantom must advertise Solana Devnet and legacy transaction support.');
  }
  return feature;
}

function payerAccount() {
  const account = phantom.accounts.find(account => account.address === payment.payer);
  if (!account?.chains.includes(chain) || !account.features.includes(signFeature)) {
    throw new Error('Select the payer shown above and enable Solana Devnet in Phantom. Then connect again.');
  }
  return account;
}

function enableConnection() {
  if (!payment || payment.replay || (payment.step !== 'direct' && payment.step !== 'balance') || localStorage.getItem(attemptKey) || !phantom) return;
  try {
    signingFeature();
    if (typeof phantom.features['standard:connect']?.connect !== 'function') throw new Error('Phantom connection is unavailable.');
    connectButton.disabled = false;
    status.textContent = 'Select Solana Devnet and the payer account in Phantom, then connect.';
  } catch (error) { status.textContent = error.message; }
}

// Wallet Standard discovery supports extensions that load before or after this page.
const app = Object.freeze({
  register(...wallets) {
    const wallet = wallets.find(wallet => wallet.name === 'Phantom');
    if (wallet) {
      phantom = wallet;
      enableConnection();
    }
    return () => {
      if (wallet !== phantom) return;
      phantom = undefined;
      connectButton.disabled = true;
      reviewButton.disabled = true;
    };
  }
});
window.addEventListener('wallet-standard:register-wallet', ({ detail }) => detail(app));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: app }));

async function read(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function publicSignature(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw new Error('Phantom did not return a transaction signature.');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = '';
  for (; value > 0n; value /= 58n) result = alphabet[Number(value % 58n)] + result;
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

function watchForInvoiceUpdate() {
  refreshPayment.hidden = false;
  async function check() {
    try {
      const next = await read('/api/payment');
      if (next.invoice_id === payment.invoice_id && next.step !== payment.step &&
          (next.step === 'balance' || next.step === 'settled')) {
        location.reload();
        return;
      }
    } catch {
      // Preparation can be unavailable while the direct transfer awaits assignment.
    }
    setTimeout(check, 3_000);
  }
  setTimeout(check, 3_000);
}

function showSignature(signature) {
  const link = document.querySelector('#signature');
  link.textContent = signature;
  link.href = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  document.querySelector('#result').hidden = false;
  copySignature.hidden = false;
  connectButton.hidden = true;
  reviewButton.hidden = true;
  if (payment.replay) {
    status.textContent = 'Use the recorded signature in the customer statement to verify it on Devnet.';
    return;
  }
  status.textContent = payment.step === 'balance'
    ? '20 USDC submitted. Open the customer statement to check finalization.'
    : '30 USDC submitted. The balance request appears after merchant assignment.';
  watchForInvoiceUpdate();
}

copySignature.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#signature').textContent);
    copySignature.textContent = 'Copied';
  } catch {
    status.textContent = 'Select the signature text to copy it.';
  }
});

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  try {
    signingFeature();
    await phantom.features['standard:connect'].connect();
    payerAccount();
    connectButton.hidden = true;
    reviewButton.disabled = false;
    status.textContent = 'Payer connected. Phantom advertises Solana Devnet and legacy transactions.';
  } catch (error) {
    status.textContent = error.message;
    connectButton.disabled = false;
  }
});

reviewButton.addEventListener('click', async () => {
  if (localStorage.getItem(attemptKey)) return;
  reviewButton.disabled = true;
  let requested = false;
  try {
    status.textContent = 'Simulating the unsigned payment on Devnet…';
    const preview = await read('/api/prepare');
    if (preview.step !== payment.step || preview.financial_revision !== payment.financial_revision ||
        preview.amount_units !== payment.amount_units || preview.reference !== payment.reference) {
      throw new Error('The invoice changed. Reload this page to review the current payment.');
    }
    const feature = signingFeature();
    const account = payerAccount();
    const transaction = Uint8Array.from(atob(preview.transaction), char => char.charCodeAt(0));
    if (localStorage.getItem(attemptKey)) throw new Error('A wallet request already exists for this payment.');
    localStorage.setItem(attemptKey, 'requested');
    requested = true;
    status.textContent = `Simulation passed. Fee before wallet adjustments is ${preview.fee_lamports.toLocaleString()} lamports. Review the transfer and total fee in Phantom.`;
    const [result] = await feature.signAndSendTransaction({
      account, chain, transaction, options: { preflightCommitment: 'confirmed', skipPreflight: false }
    });
    const signature = publicSignature(result?.signature);
    localStorage.setItem(attemptKey, signature);
    showSignature(signature);
  } catch (error) {
    if (requested && error?.code === 4001) {
      localStorage.removeItem(attemptKey);
      reviewButton.disabled = false;
      status.textContent = 'Phantom declined the request. You can reopen it for review.';
    } else if (requested) {
      status.textContent = 'Phantom returned no signature. Check wallet activity before requesting another transfer.';
    } else {
      status.textContent = error.message;
      reviewButton.disabled = false;
      connectButton.hidden = false;
      connectButton.disabled = false;
    }
  }
});

try {
  payment = await read('/api/payment');
  const reviewable = payment.step === 'direct' || payment.step === 'balance';
  const attemptStep = payment.step === 'awaiting-assignment' ? 'direct' : payment.step;
  attemptKey = `boothproof:devnet:${payment.invoice_id}:${attemptStep}`;
  document.querySelector('#invoice').textContent = payment.invoice_number;
  document.querySelector('#amount').textContent = `${(Number(payment.amount_units) / 1_000_000).toFixed(2)} USDC${reviewable ? '' : ' due'}`;
  document.querySelector('#facts').hidden = false;
  for (const field of ['payer', 'recipient', 'reference', 'mint']) {
    document.getElementById(field).textContent = payment[field] ?? 'None';
  }
  const statement = document.querySelector('#statement');
  statement.href = payment.checkoutUrl;
  statement.hidden = false;
  if (payment.replay) {
    document.querySelector('#wallet-mode').textContent = 'Devnet receipt replay';
    document.querySelector('#wallet-title').textContent = 'Phantom review · recorded payment';
  }
  const attempt = localStorage.getItem(attemptKey);
  if (payment.step === 'settled') {
    connectButton.hidden = true;
    reviewButton.hidden = true;
    status.textContent = 'Invoice settled. Open the customer statement to view both payments.';
  } else if (payment.replay) {
    connectButton.hidden = true;
    reviewButton.hidden = true;
    if (payment.recorded_signature) showSignature(payment.recorded_signature);
    else status.textContent = 'The verified transfer awaits merchant assignment.';
  } else if (payment.step === 'awaiting-assignment' && (!attempt || attempt === 'requested')) {
    connectButton.hidden = true;
    reviewButton.hidden = true;
    status.textContent = 'Payment verified. The balance request appears after merchant assignment.';
    watchForInvoiceUpdate();
  } else if (attempt === 'requested') {
    connectButton.hidden = true;
    reviewButton.hidden = true;
    status.textContent = 'Check the previous request in Phantom activity and share its public signature if submitted.';
    watchForInvoiceUpdate();
  } else if (attempt) {
    showSignature(attempt);
  } else {
    enableConnection();
  }
} catch (error) {
  document.querySelector('#amount').textContent = 'Payment request unavailable';
  refreshPayment.hidden = false;
  status.textContent = error.message;
}
