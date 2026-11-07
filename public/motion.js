// Native motion keeps the existing HTML/JS stack and leaves payment amounts and QRs untouched.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const toggle = document.querySelector('#motion-toggle');
const active = new Set();
const ease = 'cubic-bezier(.22, 1, .36, 1)';
let paused = false;
try { paused = localStorage.getItem('boothproof-motion') === 'paused'; } catch { /* Storage is optional. */ }

function stop() {
  for (const animation of active) animation.cancel();
  active.clear();
}

function syncPreference() {
  const disabled = paused || reducedMotion.matches;
  document.body.dataset.motion = disabled ? 'paused' : 'full';
  if (disabled) stop();
  if (!toggle) return;
  toggle.hidden = false;
  toggle.disabled = reducedMotion.matches;
  toggle.textContent = reducedMotion.matches ? 'Reduced motion' : paused ? 'Enable motion' : 'Pause motion';
  toggle.setAttribute('aria-pressed', String(disabled));
  toggle.title = reducedMotion.matches ? 'Your device is set to reduced motion.' : 'Control interface animations';
}

toggle?.addEventListener('click', () => {
  paused = !paused;
  try { localStorage.setItem('boothproof-motion', paused ? 'paused' : 'full'); } catch { /* Keep the current-page preference. */ }
  syncPreference();
});
reducedMotion.addEventListener('change', syncPreference);
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
window.addEventListener('beforeprint', stop);
syncPreference();

function animate(node, keyframes, options = {}) {
  if (!node || !node.animate || paused || reducedMotion.matches || document.hidden) return;
  const animation = node.animate(keyframes, { duration: 380, easing: ease, fill: 'backwards', ...options });
  active.add(animation);
  // Cancellation is expected when motion is paused or a page is replaced.
  animation.finished.then(() => active.delete(animation), () => active.delete(animation));
}

export function revealWorkspace(root) {
  stop();
  const targets = root.querySelectorAll('.hero-copy, .page-intro, .stats, .desk-grid > .panel, .invoice-import, .orders-panel, .guide-grid > .panel, .customer-panel');
  targets.forEach((node, index) => {
    const fixed = !node.matches('.hero-copy, .page-intro, .guide-panel');
    animate(node, fixed ? [{ opacity: .45 }, { opacity: 1 }] : [
      { opacity: 0, transform: 'translateY(12px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 440, delay: Math.min(index * 45, 180) });
  });
}

export function revealPayment(root, { settled = false } = {}) {
  animate(root.querySelector('.payment-heading, .customer-panel h1'), [
    { opacity: .55, transform: 'translateY(4px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 250 });
  animate(root.querySelector('.overpayment-note'), [{ opacity: .4 }, { opacity: 1 }]);
  if (!settled) return;
  animate(root.querySelector('.receipt-proof'), [
    { opacity: .2 },
    { opacity: 1 }
  ], { duration: 420 });
  animate(root.querySelector('.proof-mark'), [
    { transform: 'scale(.7)', opacity: .4 },
    { transform: 'scale(1.12)', opacity: 1, offset: .65 },
    { transform: 'scale(1)', opacity: 1 }
  ], { duration: 520 });
}

export function revealRows(root) {
  root?.querySelectorAll('tbody tr').forEach((row, index) => {
    if (index >= 8) return;
    animate(row, [{ opacity: .35 }, { opacity: 1 }], { duration: 240, delay: index * 20 });
  });
}
