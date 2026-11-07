# Boothproof recovery rehearsal

## Hackathon take

Lead with the **42-second continuous Devnet receipt replay**. It follows one browser tab through verification, assignment, the checkout’s Phantom handoff, settlement, and both signature replays. Each receipt is checked against finalized Devnet RPC in a fresh isolated ledger. The wallet page shows the two previously signed receipts with signing controls disabled. [One-take recording](output/playwright/hackathon-one-take-devnet-replay.webm)

> These two payments already finalized on Devnet. I’ll verify the direct 30 USDC, assign it, and follow checkout’s Phantom review for the referenced 20 USDC. Boothproof ends at 50 received with both proofs attached.

1. Open the 50-USDC invoice and choose **Open checkout**. Follow **Review recorded 30 USDC**, copy its signature, then return through **Customer statement**. Submit the signature through **I already paid** and show 50 still due.
2. Return to Invoices and choose **Inspect recovery report**. Select the invoice in the assignment dialog and confirm the preview showing 30 received and 20 due.
3. Open the same checkout and choose **Review in Phantom · receipt replay**. Show its 20-USDC amount and invoice reference. Copy the finalized signature and verify it from the customer statement.
4. Finish at **Reconciled** with 50 received, zero due, and two payments. Submit both signatures again to show the existing allocations.

For a fresh rehearsal, run the command from the project directory, open the workspace, and select **Solana Devnet**. Each start creates a new replay ledger from the saved invoice header. The supplied Playwright script performs the full sequence through the browser controls.

```powershell
node --env-file-if-exists=.env scripts/hackathon-replay.js
# In another terminal
playwright-cli -s=hackathon open 'http://127.0.0.1:4180/#invoices' --browser chrome
playwright-cli -s=hackathon run-code --filename scripts/record-hackathon-demo.js
```

The live acceptance checkout links to **Send 30 USDC without a reference** and then **Review in Phantom**, which opens the helper used for the actual approvals in Brave. The generic **Open Solana Pay link** is available for compatible wallets and still needs a separate Brave test. [Original live approval evidence](DEVNET_ACCEPTANCE.md)

## Offline fallback — at most two minutes

Keep **Demo mode** and simulated evidence visible. Do not present fixture signatures as Devnet transactions.

| Time | Action and explanation |
| --- | --- |
| 0:00–0:15 | Select the 50 USDC invoice with a 30 USDC deposit. Show zero received and 50 due. |
| 0:15–0:30 | Use **Practice reference-free 30 USDC**. Explain that verification is receipt evidence; the balance stays unchanged until assignment. |
| 0:30–0:50 | Open Recovery. Show amount, receiving wallet, unconfirmed source identity, and invoice suggestion. Choose Assign, select the invoice, and show the preview: 0 → 30 received, 20 remaining, zero excess. Confirm. |
| 0:50–1:10 | Open the customer statement. The deposit is met. Simulate the referenced 20 USDC balance payment. Show two payments, 50 received, zero remaining. |
| 1:10–1:25 | Report the 30 USDC signature through **I already paid**. It is already allocated; totals stay unchanged. |
| 1:25–1:50 | Stop and restart the server, then reload the same statement. Report the 20 USDC signature too. Saved payments still total 50. |
| 1:50–2:00 | Close on the saved statement. Explain that manual assignment is reversible with a reason, while transfer proof is retained. |

The current workspace recording is [workspace-recovery-demo-simulated.webm](output/playwright/workspace-recovery-demo-simulated.webm): **65.84 seconds, 1366×900, 25 fps**, with Chrome playback/seeking checked. It includes a real restart of the isolated QA process and replay of both fixture signatures. The earlier `invoice-recovery-demo.webm` is retained separately. Both are practice evidence only.

For a fresh isolated recording:

1. Run `node scripts/browser-qa-server.js` and open `http://127.0.0.1:4174` using Playwright CLI.
2. Run `run-code --filename scripts/prepare-recovery-demo.js` in that session.
3. Run `video-start output/playwright/workspace-recovery-demo-simulated.webm --size 1366x900` and `run-code --filename scripts/record-recovery-demo.js`. Choose a new filename when preserving an existing recording.
4. Actually stop and restart **the QA server**, leaving the browser open. Run `run-code --filename scripts/finish-recovery-demo.js`, then `video-stop`.

The preparation creates a new invoice and never overwrites operator data. Ensure the recording stays under two minutes. `node scripts/review-artifacts.js` serves only the named QR/video artifacts on loopback port 4176; `run-code --filename scripts/verify-workspace-video.js` checks the current video in Chrome. Stop owned QA/artifact servers afterward.

The opening now shows the compact register/desk workspace. After the reference-free practice payment, use **Inspect recovery report** to reach that invoice's report directly. The assignment preview remains explicit. A changed financial revision disables confirmation until **Refresh preview**; notes remain intact. A lost response uses **Retry saved decision** with the same request ID and payload.

## Real Devnet acceptance

The completed live invoice **LIVE-20261106-508edd** shows 50 received and zero remaining. Its separate acceptance database retained two finalized legacy payments, both allocation methods, and all five audit events through replay and restart. [Live acceptance record](DEVNET_ACCEPTANCE.md) · [47-second recap from captured screens](output/playwright/devnet-live-evidence-recap.webm)

The receiver is `22o6Af5tUNGwbtz6NKeZF6YGFHg4MfXvWfuYqDvKt1VP`. The separate payer is `CXhDCE1DUPd91gGTEdWETEhncay7QXdvdsez9LjqaVbq`, initially funded with 50 test USDC and 20.0125 test SOL. The user reported Brave for the Phantom signing workflow. Both live simulations quoted 5,000 lamports before wallet adjustments. Each finalized fee was 80,000 lamports with priority fees.

The local review page checks the saved payer, Devnet chain, and legacy signing support, then simulates a fresh request before opening the wallet. It advances after assignment and displays settlement when the invoice is paid. [Phantom review page](http://127.0.0.1:4177/)

The completed run followed these steps.

1. Started the isolated acceptance instance and selected Solana Devnet in the merchant UI and wallet. The public-wallet preflight and `npm.cmd run devnet:check` confirmed balances and mint.
2. Open the saved customer checkout and the local Phantom review page in Chrome. Select the saved payer and Solana Devnet in Phantom. Choose **Connect Phantom** and **Review in Phantom**.
3. Review and approve **30 USDC without an invoice reference** in Phantom. Save the public signature and Devnet Explorer link. Run `node --env-file-if-exists=.env scripts/devnet-acceptance.js evidence --signature ACTUAL_SIGNATURE` to retrieve finalized proof and version. Record ownership, mint, exact net credit, and reference absence. Retry pending verification using the same signature.
4. Paste that signature into **I already paid**. Record `unallocated`, 30 USDC verified, and 50 still outstanding. If unsupported, record the actual reason and wallet transfer format; do not substitute a Demo fixture.
5. In Recovery, inspect the evidence and assign the whole payment to the invoice. Record 30 received and 20 remaining.
6. In customer checkout, choose **Pay remaining balance**. Reopen the Phantom review page for the same referenced 20-USDC request. Review and approve it in the wallet, then record the signature and Explorer link. Wait for finalization or use **Check payment**.
7. Replay both signatures. Received must remain 50 USDC, with two allocated payments.
8. Restart the **same acceptance process and database**, then reload the statement. Compare the identity, reference, payments, history, and totals. Export the history and safe statement with `node --env-file-if-exists=.env scripts/devnet-acceptance.js snapshot`.

The exact before-and-after restart fingerprints and both transaction links are saved with the final CSV and screenshots. [Live acceptance record](DEVNET_ACCEPTANCE.md) · [History CSV](output/playwright/devnet-acceptance-history.csv)

## Additional merchant checks

- Reverse a manual assignment with a reason. Outstanding increases; proof remains in Recovery and audit history. A delayed retry of the original assignment must return saved current state without reapplying it.
- Create excess, acknowledge its review with a note, and show the unchanged excess. New excess evidence reopens review. A reversal removing the excess clears that case.
- Use a deposit after a prior recovered payment. The request asks only for the remaining deposit target, preserving six-decimal remainders.
- Import the five-column CSV twice. The identical second import skips records. A conflicting batch creates nothing.
- Inspect Guide links to legacy Booth and Ledger; verify existing accepted receipts and sales remain available.

The project predates the event. Reuse eligibility is unconfirmed; consult the organizers and disclose prior work/AI assistance accurately.
