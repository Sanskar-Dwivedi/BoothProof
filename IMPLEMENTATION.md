# Boothproof implementation handoff

Updated November 7, 2026 (IST). The focused invoice workspace and four review fixes are implemented and verified. The two-wallet Devnet run settled the invoice, passed both signature replays, and preserved its ledger through restart. The project uses Node.js 24+, built-in SQLite, vanilla JavaScript, local fonts and colors, integer accounting, and loopback operation.

## Focused workspace

Invoices now starts with a short title/mode/action row, compact summary, and attention links. A 40% register / 60% invoice desk replaces the long vertical sequence. New invoice and Import CSV use native dialogs. The desk foregrounds identity, expected/received/remaining totals, signature verification, and a distinct verified-but-unallocated report with a direct Recovery action. Evidence and history follow the decision controls.

At 1366×900, the browser measured the desk at **59.19%** of the workspace width and confirmed register, identity, totals, signature form, and recovery action fully inside the first viewport. At 360×800, the picker/View details flow reaches the stacked desk with no page overflow. No nested vertical scroll area was introduced. Keyboard opening/Escape, launcher focus restoration, signature/creation drafts, notes, selection after reload, and focus across polling were checked.

## Review findings reproduced and fixed

| Finding | Reproduction before fix | Final behavior / regression |
| --- | --- | --- |
| Delayed checkout response | Held an old 50-due GET, settled the invoice, then released it; the UI restored 50 and payment controls. | Durable per-invoice projection revisions and request sequencing reject old state. Mutation epochs discard stale collection reads. Browser checks cover a delayed poll and obsolete payment-option response. Reversals can correctly reduce received amounts. |
| Stale assignment preview | Changed the target balance while its payment version stayed unchanged; the old preview was accepted with HTTP 200. | Required `expected_invoice_revision` is checked inside the allocation transaction alongside `expected_version`. A changed target returns 409 `STALE_INVOICE` and a safe current projection. Explicit Refresh preview and renewed confirmation are required. A balance returning to its earlier value still invalidates the old preview. |
| Report against another invoice | A signature suggested for A was accepted for B despite no durable B report. | Explicit 409 `RECOVERY_REPORT_CONFLICT` on verification and atomic ingestion. Concurrent first reports retain exactly one suggestion. B has no false pending status after reload; the merchant can still assign to another compatible invoice. |
| Legacy checkout signature form | Its signature submission was rejected as an unexpected field, HTTP 400. | Legacy checkout/check accepts an optional validated signature through the existing verifier and returns only the customer projection. Invoice checkout/check retains its strict empty-input contract. Unexpected payment-fact fields remain rejected. |

Projection revisions count append-only audit events within each invoice. Financial revisions count only invoice creation, allocations, and reversals. Review acknowledgments do not invalidate a financial preview. No global row ID or other-invoice activity counter is exposed. A lost allocation response retains the exact payload/request ID and freezes uncertain inputs; retry returns saved current state without reapplying credit.

## Verification actually completed

| Check | Observed result |
| --- | --- |
| Baseline rerun before this update | 38 passed with localhost access. |
| Current `npm.cmd test` | **48 passed, 0 failed**. A verified recovery recorded during simulation blocks the pending unsigned preparation with HTTP 409. |
| `npm.cmd run devnet:check` | Passed: finalized Devnet slot **519432108**, canonical six-decimal standard SPL USDC mint. No payment sent. |
| `scripts/browser-review-regressions.js` | Passed in Chrome with the in-memory review server. Checks covered option ordering in both directions, obsolete errors and loading state, delayed responses after settlement, stale previews, recovery conflicts after reload, keyboard focus, drafts, and desktop and mobile layout. |
| `scripts/browser-workflow.js` | Passed: reference-free 30 fixture, unallocated customer state, assignment, deliberately lost response/retry, referenced 20 fixture, both replays, reload, reversal, privacy, preserved drafts/focus, desktop/mobile; no JavaScript runtime errors. |
| Updated recorded rehearsal | **65.84 seconds**, 1366×900, 25 fps; Chrome playback/seeking verified with no media error. Actual QA process restart; 50 received, zero remaining, two fixture payments afterward. |
| Live Devnet acceptance | Two finalized legacy payments. The direct 30 stayed unallocated until merchant assignment. The referenced 20 settled the invoice. Both replays and the restart preserved two payments, five audit events, and the CSV fingerprint. |
| Wallet review page | Verified the submitted-to-balance transition at 360px with controlled browser responses. The actual restarted paid invoice displays settlement and blocks new unsigned requests. |
| Hackathon one take | Fresh isolated replay ledger. The same checkout linked to both wallet review steps. Actual finalized RPC re-verified both saved receipts. The ledger finished at 50 received and zero due. Both replays preserved two payments and five audit events. Chrome played and sought the 41.56-second recording. |

Before the race fixes, the Node regression failed because preparation resolved after a verified recovery was recorded. Chrome reproduced both incorrect selections and wallet URLs, the obsolete error, and premature clearing of the newer request's loading state. The same regressions passed after the fixes. [Node before](output/playwright/review-races-before-node.txt) · [Chrome before](output/playwright/review-races-before-browser.txt) · [Node after](output/playwright/review-races-after-node.txt) · [Chrome after](output/playwright/review-races-after-browser.txt)

Earlier Node coverage includes target revisions (including balance returning to its earlier value), projection/financial revision separation, simultaneous report races, another-invoice conflicts, filtered legacy verification, and exact public wallet balance/rent preflight. Existing verifier, migration, precision, idempotency, monitor, and legacy/v0 regressions remain passing. Frozen token accounts do not count as spendable funds.

## Artifacts and ledger isolation

All paths below are under `output/playwright/`. The earlier 55.6-second `invoice-recovery-demo.webm` is retained separately.

- [Current simulated recording](output/playwright/workspace-recovery-demo-simulated.webm), [local video preview](output/playwright/workspace-video-preview.html).
- [1366×900 focused workspace](output/playwright/workspace-focused-desktop.png), [360px picker/register](output/playwright/workspace-focused-mobile-register.png), [360px desk](output/playwright/workspace-focused-mobile-desk.png).
- [Simulated assignment preview](output/playwright/workspace-simulated-allocation-preview.png), [simulated statement after restart](output/playwright/workspace-simulated-restarted-statement.png).
- [Actual unpaid Devnet preparation](output/playwright/devnet-acceptance-prepared-desktop.png), [public run metadata](output/playwright/devnet-acceptance-20261106.json), [unpaid customer snapshot](output/playwright/devnet-acceptance-statement.json), [current history CSV](output/playwright/devnet-acceptance-history.csv).

`qa.sqlite` contains Demo fixtures only. `devnet-acceptance-20261106.sqlite` is the real acceptance ledger, seeded with no fixtures. The operator's `data/boothproof.sqlite` was not opened, reset, or overwritten during this update. Earlier migration safeguards remain intact; the previous handoff recorded migration of seven saved booth orders and three new examples, followed by repeat startup without remigration. Its pre-migration backup remains in `data/backups/`.

## Real Devnet status and compatibility

The actual payer used Phantom in Brave as reported. Both transfers finalized as legacy transactions with verified wallet ownership and canonical USDC. The first 30 was manually allocated and the referenced 20 posted through the monitor. The receiver's balance increased from 40 to 90 test USDC. Both signed transfers charged 80,000 lamports including priority fees. [Acceptance record](DEVNET_ACCEPTANCE.md)

The acceptance runner serves a loopback wallet review page. It prepares a one-instruction legacy transfer, verifies token accounts, and simulates the unsigned bytes. Wallet Standard passes the saved payer and Devnet chain to Phantom. The balance request uses the actual checkout amount and reference. After submission the page hides the old action, advances when assignment saves, and displays the settled state on reload. The fee label distinguishes the unsigned quote from the total shown in the wallet. [Wallet Standard signing contract](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/features/src/signAndSendTransaction.ts)

The configured customer checkout now offers that helper explicitly. `scripts/hackathon-replay.js` reads the completed acceptance invoice header and opens a fresh replay ledger with its reference intact. Both signatures go through normal finalized verification and allocation. The replay wallet page exposes the public receipts and rejects signing preparation. The generic Solana Pay URI still needs an independent Brave test. [One-take recording](output/playwright/hackathon-one-take-devnet-replay.webm)

No evidence currently requires v1. The verifier still validates legacy/v0 and rejects unsupported versions with 422; `maxSupportedTransactionVersion` remains 0. Raising it alone would be incorrect because v1 requires message/configuration validation. If the selected wallet requires v1, implement/test that boundary before requesting payment, or first demonstrate a compatible legacy/v0 workflow.

## Files changed in this update

| Area | Files |
| --- | --- |
| Interface | `public/app.js`, `public/styles.css` |
| HTTP, persistence, verification/preflight | `server/app.js`, `server/store.js`, `server/payments.js`, `server/solana.js` |
| Tests | New `test/workspace.test.js`; updated `test/recovery.test.js` allocation inputs and `test/solana.test.js` preflight coverage |
| Browser checks/rehearsal | New `scripts/browser-review-regressions.js`, `scripts/verify-workspace-video.js`; updated `scripts/browser-workflow.js`, `scripts/prepare-recovery-demo.js`, `scripts/record-recovery-demo.js`, `scripts/finish-recovery-demo.js` |
| Live preparation / artifact viewing | `scripts/devnet-acceptance.js`, `scripts/devnet-wallet.js`, `scripts/devnet-wallet.html`, `scripts/devnet-wallet-browser.js`, `scripts/browser-devnet-wallet.js`, `scripts/hackathon-replay.js`, `scripts/record-hackathon-demo.js`, `scripts/review-artifacts.js` |
| Documentation | `README.md`, `REHEARSAL.md`, `IMPLEMENTATION.md`, new `DEVNET_ACCEPTANCE.md` |

`package.json`, QR library, font assets, five-column CSV format, schema version, migration code, and monitor scheduling are unchanged. The workspace is not a Git checkout, so no Git diff/commit was produced.

## Operating limits

Keep the server on loopback. One local operator and one receiver are supported; the customer projection provides no authentication boundary. Whole payments go to one invoice. Source ownership does not establish client identity. Unsupported transfers require investigation. Old copied payment URLs can still cause visible excess; reversals/acknowledgments never refund tokens. Monitoring continues without tabs with existing pagination, resume, backoff, and four-call limits. Event reuse eligibility remains unconfirmed.
