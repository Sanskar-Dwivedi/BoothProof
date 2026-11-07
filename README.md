# Boothproof

A local invoice reconciliation and payment recovery desk for freelancers and small studios receiving USDC. Node.js 24+, built-in SQLite, and vanilla JavaScript; no runtime package installation.

A client owes **50 USDC** and sends **30 USDC without the invoice reference**. Boothproof verifies receipt, keeps the transfer unallocated, and leaves the invoice at 50 USDC due. The merchant assigns the whole payment, leaving 20 USDC. A referenced checkout payment settles that remainder. Replaying either signature cannot add credit again.

## Run locally

```powershell
npm.cmd start
```

Open [Invoices](http://127.0.0.1:4173/#invoices). The server binds to **127.0.0.1**. Keep one local operator and one receiving wallet. Customer checkout is a filtered local view, **not authentication**. Do not expose this server publicly.

Data is saved in `data/boothproof.sqlite`. Stop an older application process before the first upgraded startup, including copies on another port. The main entrypoint checks its port before opening the database, and the new store holds an exclusive process lock.

```powershell
npm.cmd test
npm.cmd run devnet:check
```

The tests use isolated databases and controlled RPC responses, without external networking. The Devnet check contacts the configured network and checks the finalized slot and canonical USDC mint; it does not exercise a payment or move funds.

## Practice the recovery flow

New databases contain three invoice examples: an unpaid 50 USDC invoice with a fixed 30 USDC deposit, a partially paid invoice, and an overdue invoice with an excluded wrong-token attempt. Existing invoices are never overwritten. Legacy booth examples and saved booth routes remain available through Guide.

1. In **Demo mode**, select the 50 USDC invoice. Open **Practice invoice payments · offline** and choose **Practice reference-free 30 USDC**.
2. The transfer is verified, but received remains zero. Open **Recovery** to inspect its exact amount, source wallet, recipient, provenance, times, and suggested invoice.
3. Choose **Assign to invoice**, select the invoice, and review received before/after, the remaining balance, and any excess. Confirm the assignment.
4. Open the customer statement. Received is 30 USDC and remaining is 20 USDC. The deposit has already been met. Choose **Simulate remaining balance**.
5. Report either saved signature through **I already paid**, or repeat the practice action. Received stays 50 USDC. Restart and open the same statement to inspect saved evidence.

Demo signatures come from deterministic server fixtures. Repeating an action reuses its signature. `workspace-recovery-demo-simulated.webm`, `workspace-simulated-*`, and `workspace-focused-*` record the offline QA run. The `devnet-live-*` and `devnet-acceptance-*` artifacts record the separate live Devnet run, including both finalized payments and the settled ledger. [Live acceptance record](DEVNET_ACCEPTANCE.md)

## Merchant and customer behavior

- **Invoices:** compact summary and attention links above a register/desk workspace, approximately 40%/60% at desktop widths. Native dialogs hold New invoice and Import CSV. Expected, received, remaining, signature verification, and a verified-but-unallocated report action appear before detailed evidence/history. At 360px, use the invoice picker and View details. Financial states are unpaid, partial, paid, and overpaid; review state is separate.
- **Recovery:** verified incoming transfers await explicit assignment. A reported invoice is a suggestion. The source wallet is not verified client identity. The full payment goes to one invoice using the same mode and receiving wallet. Amount, timing, and client names never trigger automatic matching.
- **Reversal:** a merchant can reverse a manual assignment with a reason. Credit is removed; the transfer and history remain. Reference and legacy assignments cannot be redirected or reversed. This application does not execute refunds.
- **Review:** acknowledgment requires a note and changes only the attention flag. Invalid transfers remain excluded. Excess stays visible after acknowledgment. New contributing payment evidence reopens excess review; a reversal removing excess clears it.
- **Customer checkout:** shows invoice details, balances, receiving wallet, payment options, relevant verified payments, safe recovery status, and monitoring. It excludes merchant decision notes, audit actions, and other invoices. A recovered payment awaiting allocation does not reduce the balance; the customer is told to wait before paying again.

Polling preserves selection, open details, signature drafts, and decision notes. Durable per-invoice revisions prevent a delayed response from restoring an earlier balance or obsolete payment request, including after a reversal. Assignment captures both the payment version and the target invoice's financial revision. A changed target requires **Refresh preview** and renewed confirmation; an uncertain response retries the exact saved decision/request ID. Reporting an already-unallocated signature against a different invoice returns an explicit conflict. Its first suggestion remains nonbinding for the merchant's actual assignment.

Allocation API clients must send `expected_invoice_revision` as the decimal string shown in `order.invoice.financial_revision`, alongside `request_id`, `expected_version`, and `invoice_id`. The store checks both versions atomically; a changed target returns `409 STALE_INVOICE` and a safe current customer projection. Review-only changes do not invalidate a financial preview. Legacy customer signature entry remains supported with the same filtered response.

Amounts are calculated with integer units and `BigInt`. Invoice and deposit creation accept 0.01–9,999.99 USDC with at most two decimals; the deposit must be below the total. Verified payments and remainders retain all six decimals. A deposit is a **cumulative fixed target**, reduced by all active payments, including recovered payments. The server generates current deposit/balance requests using the same reference. An older copied URL can still produce an excess payment, which remains visible.

Five-column CSV imports remain `invoice_number,client,title,amount,due_date`. Imports are atomic, at most 100 rows, and identical imports are skipped. Imported invoices have no deposit. Statement exports preserve existing columns and append deposit/review information. Per-invoice history CSV distinguishes verified transfers, assignments, reversals, and acknowledgments, and escapes spreadsheet formulas in user text.

## Solana Devnet

Copy `.env.example` to `.env` and set `MERCHANT_WALLET` to the receiving wallet's **public address**, not its token-account address. Optionally set a trusted HTTPS `SOLANA_RPC_URL`. Restart and choose **Solana Devnet**.

Use separate payer and receiver test wallets. The payer must have test SOL for fees and standard Devnet USDC. The user signs in their own wallet; Boothproof never requests private keys or seed phrases. Select Devnet in the wallet before opening a Solana Pay request. Wallet interoperability must be demonstrated with actual signed transactions; connectivity alone does not confirm it.

The isolated live run passed. Phantom in Brave submitted a reference-free 30 USDC transfer and the referenced 20 USDC remainder as finalized legacy transactions. Boothproof preserved the unallocated state until merchant assignment and then settled the invoice by reference. Both signature replays and an actual restart preserved the ledger and CSV. [Acceptance record](DEVNET_ACCEPTANCE.md)

For the configured acceptance invoice, the customer checkout links to **Send 30 USDC without a reference** and **Review in Phantom**. These open the same wallet review helper used for the original approvals. The generic Solana Pay URI remains a separate option for compatible wallets and still needs a Brave compatibility test.

Reopen the settled acceptance invoice from its isolated database.

```powershell
node --env-file-if-exists=.env scripts/devnet-acceptance.js serve
# Separate terminal for read-only video preview
node scripts/review-artifacts.js
```

Open Invoices on port 4175 and select **Solana Devnet**. The wallet review page on port 4177 now shows settlement. During a live run it hides submitted actions and advances to the referenced remainder after merchant assignment. [Settled customer statement](http://127.0.0.1:4175/pay/b02ea657-ca79-4c80-a8ce-f09d51cfcac8) · [Phantom review page](http://127.0.0.1:4177/)

Supported verification:

- Finalized successful **legacy or v0** transactions, including resolved lookup-table addresses.
- One direct top-level standard Token Program `Transfer` or `TransferChecked`.
- Account creation, compute-budget instructions, and memos around an unreferenced transfer; newly created destination token accounts with creation evidence.
- Canonical Devnet USDC, six decimals, destination ownership matching the saved receiving wallet, exact destination net credit, consistent source ownership/debit, and a non-self transfer.
- A known reference binds only as a read-only, non-signing extra account on the final transfer instruction. A malformed known reference cannot fall back to manual recovery. A reference belonging to another order conflicts.

Unsupported: CPI-only payments, multiple transfers, delegated or multisig forms outside the parser, Token-2022, missing ownership/balance evidence, unknown companion programs, and transaction versions above v0. Unsupported/rejected transfers create no credit. A `null` finalized lookup means **not found at finalized commitment**, not proof that the transaction does not exist. Retry pending signatures without paying again.

No mainnet, whole-wallet discovery, payment splitting, authentication, multiple merchants, refunds, swaps, subscriptions, AI features, or custom programs are included.

## Background checking

Monitoring runs in the Node process with all browser tabs closed:

- Unpaid/partial invoices: every 10 seconds.
- Paid/overpaid invoices: every 60 seconds for 24 hours after their latest allocation change; manual checking stays available afterward.
- Unfinished scans resume across restarts and outside the usual monitoring window. Newly migrated invoices get a catch-up scan.
- History pages contain 50 signatures. Saved page dispositions, pagination cursors, scan heads, and completed watermarks prevent skipped entries. A temporary null transaction stays pending. A missing prior watermark reports a history gap and preserves the old completion boundary.
- Each job has a 10-second budget. Work rotates fairly among invoices. Failures back off 10, 20, 40, then 60 seconds. Actual RPC calls are capped at four, with shared transaction lookups and overlapping checks coalesced.

The interface shows last attempt, last complete scan, catching-up status, and errors. An incomplete/stale scan is not labeled current. Browser polling reads saved state every five seconds and preserves typed forms; only an explicit check performs verification.

## Migration and recovery

Schema version is `PRAGMA user_version = 1`. Before changing a legacy file-backed database, startup creates a timestamped backup in **`data/backups/` using SQLite `VACUUM INTO`**. Backup failure aborts startup. Schema changes/backfill occur in one transaction; the migration compares every invoice's expected, received, remaining, and excess amounts, preserves legacy orders/evidence/accepted receipt identities, and checks integrity and foreign keys. No RPC calls run in migration. Repeated startup does not rerun migration. A newer unsupported schema stops startup.

Legacy accepted and short/additional booth payments are reserved in the shared registry with `legacy` provenance and their original associations. Rejected evidence becomes review cases for invoices and never becomes verified credit. Source accounts, owners, and historical chain time not previously stored remain unknown.

To restore a backup:

1. Stop Boothproof and any older copy. Confirm it is no longer running.
2. Preserve the current database **and its `-wal`/`-shm` companions together** under archival names. Keep these files available for investigation; never copy only the main file from a live WAL database.
3. Copy the chosen timestamped backup from `data/backups/` to `data/boothproof.sqlite`. Ensure no old WAL/SHM files remain under the active database's companion filenames.
4. Start the current application. A pre-upgrade backup will migrate again, including fresh validation and a new backup.

A stale lock from a dead process is reclaimed automatically. If its recorded PID belongs to a live process, inspect that process before removing the lock. Do not force a schema version backward. Running old application code against the new registry can show incorrect balances; reverting code requires a matching pre-upgrade database backup.

## Verification and handoff

See [REHEARSAL.md](REHEARSAL.md) for the two-minute demonstration and actual Devnet acceptance steps, and [IMPLEMENTATION.md](IMPLEMENTATION.md) for changed files and recorded verification.

The offline browser rehearsal uses `output/playwright/qa.sqlite` for its Demo fixtures and restart checks.

```powershell
node scripts/browser-qa-server.js
# In another terminal, with Playwright CLI and a browser installed:
playwright-cli -s=boothproof open http://127.0.0.1:4174 --browser chrome
playwright-cli -s=boothproof run-code --filename scripts/browser-workflow.js
```

Stop the rehearsal server before starting the review server on the same port. Review mode uses an in-memory ledger and mock RPC.

```powershell
node scripts/browser-qa-server.js --review
# In another terminal:
playwright-cli -s=boothproof-review open http://127.0.0.1:4174 --browser chrome
playwright-cli -s=boothproof-review run-code --filename scripts/browser-review-regressions.js
playwright-cli -s=boothproof-review close
```

Stop the review server with Ctrl+C when the checks finish. The Chrome checks verified payment-option ordering in both directions, stale errors and loading state, delayed responses after settlement, stale previews, recovery conflicts, and desktop and 360px layouts. `npm.cmd test` reported **48 passed, 0 failed**, including recovery arriving during unsigned wallet preparation.

The primary hackathon recording shows the checkout-linked Phantom flow in one take. It re-verifies the two earlier finalized Devnet receipts with live RPC in a fresh replay ledger. [42-second hackathon take](output/playwright/hackathon-one-take-devnet-replay.webm) · [Runbook](REHEARSAL.md) · [Offline fallback](output/playwright/workspace-recovery-demo-simulated.webm)

This code is pre-event rehearsal work. Submission eligibility and permission to reuse it are **unconfirmed**; no organizer approval is recorded. Disclose prior work and AI assistance according to the event's requirements.

Technical references: [Solana Pay binding specification](https://solana.com/docs/tools/solana-pay/specification/version1), [transaction metadata](https://solana.com/docs/rpc/json-structures), [finalized transaction lookup](https://solana.com/docs/rpc/http/gettransaction), [paginated reference history](https://solana.com/docs/rpc/http/getsignaturesforaddress), [official Solana development skill and references](https://github.com/solana-foundation/solana-dev-skill/tree/main/skills/solana-dev), [Phantom legacy signing](https://docs.phantom.com/solana/sending-a-transaction), [Phantom v0 signing](https://docs.phantom.com/solana/sending-a-transaction-1), [Phantom test networks](https://help.phantom.com/articles/use-testnets-in-phantom-5997313271699), [SQLite consistent backups](https://sqlite.org/lang_vacuum.html). Existing fonts, theme, QR library, and [design attributions](design/README.md) are retained.
