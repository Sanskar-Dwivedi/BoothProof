# Real two-wallet Devnet acceptance

**Passed on November 7, 2026 (IST).** Invoice **LIVE-20261106-508edd** is settled with 50 USDC received, zero due, and two allocations. Both signature replays and an actual restart preserved the saved ledger and history export.

## Invoice and public wallets

| Item | Value |
| --- | --- |
| Invoice ID | `b02ea657-ca79-4c80-a8ce-f09d51cfcac8` |
| Invoice reference | `6VMdEnsjL4Rsw1Gx3h2d6ZCtCEpo9HBd9mJzpBqywPTZ` |
| Total and deposit target | 50 USDC and 30 USDC |
| Payer | `CXhDCE1DUPd91gGTEdWETEhncay7QXdvdsez9LjqaVbq` |
| Receiver | `22o6Af5tUNGwbtz6NKeZF6YGFHg4MfXvWfuYqDvKt1VP` |
| Wallet | Phantom browser extension. The user reported Brave for the live run and previously reported extension version 26.38.0. |
| RPC and cluster | `https://api.devnet.solana.com` · Devnet genesis checked |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` · six decimals |
| Standard Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Isolated database | `output/playwright/devnet-acceptance-20261106.sqlite` |

The preflight at finalized slot **519556549** found 50 spendable test USDC and 20.0125 test SOL in the payer, and 40 test USDC in the receiver. The receiver already owned its destination token account. The post-settlement check at slot **519566499** found 0 USDC and 20.01234 SOL in the payer, and 90 USDC in the receiver. The invoice accounts for the exact 50-USDC increase. [Public metadata and balance evidence](output/playwright/devnet-acceptance-20261106.json)

## Finalized transfers

- **30 USDC without a reference** finalized at slot **519562217** at **11:28:28 IST**. The legacy transaction debited the payer and credited the receiver exactly 30,000,000 units. Boothproof verified it through **I already paid**, kept it unallocated through a reload, and applied it after merchant assignment. Public signature `2gGmc7KyTJG3abNie78tRgT5U6S6w6k3YgPuYmzTzPi48kPJ3JMurhs1kgrvN3ceVeRKyzS7eyAbvxW7s3eqpnfY`. [Devnet Explorer](https://explorer.solana.com/tx/2gGmc7KyTJG3abNie78tRgT5U6S6w6k3YgPuYmzTzPi48kPJ3JMurhs1kgrvN3ceVeRKyzS7eyAbvxW7s3eqpnfY?cluster=devnet)
- **20 USDC with the invoice reference** finalized at slot **519564106** at **11:36:01 IST**. The legacy transaction debited and credited exactly 20,000,000 units. The reference was the final transfer instruction's read-only, non-signing extra account. The invoice monitor applied the payment by reference. Public signature `3rspW6Tdq8T3U87jjgmgv85pxSu6sFUbPun3V1YVPZ7Cv45H9kG1rwXvumafrz6UgtnyipUChqYWCyrm4RYEhPuw`. [Devnet Explorer](https://explorer.solana.com/tx/3rspW6Tdq8T3U87jjgmgv85pxSu6sFUbPun3V1YVPZ7Cv45H9kG1rwXvumafrz6UgtnyipUChqYWCyrm4RYEhPuw?cluster=devnet)

Both finalized RPC results proved source ownership by the payer and destination ownership by the receiver for the canonical mint. The source token account was `13nTejXjJmBbDtY2hc4bR4RkBNAi2C3CRRzRUgZupxRY`. The destination was `BsUbwpeQZj54BQtMiDTaP6QcEkbpt3eRshXczN3gLNPn`. [Finalized RPC evidence](output/playwright/devnet-acceptance-20261106.json)

Both unsigned legacy requests passed live Devnet simulation and each quoted 5,000 lamports. Both signed transactions included Compute Budget instructions with a 200,000-unit limit and a price of 375,000 micro-lamports per unit. Their actual fees were **80,000 lamports each**, including a 75,000-lamport priority fee. The review page now labels the quote as the fee before wallet adjustments and asks the user to review the total in Phantom. [30-USDC simulation](output/playwright/devnet-direct-30-simulation.json) · [20-USDC simulation](output/playwright/devnet-balance-20-simulation.json) · [Solana fee structure](https://solana.com/docs/core/fees/fee-structure)

## Observed acceptance steps

| Step | Expected | Observed |
| --- | --- | --- |
| Open saved Devnet invoice | 0 received, 50 due, 30 deposit target | Matched |
| Verify the first signature | Verified and unallocated, 0 received, 50 due | Matched after reload |
| Assign in Recovery | 30 received, 20 due, deposit satisfied | Matched |
| Verify referenced balance | 50 received, zero due, two allocations | Matched via the invoice monitor |
| Replay both signatures in customer UI | Same two payment records and balance | Both returned the existing allocations. All five audit entries matched. |
| Restart the same isolated instance | Same invoice ID, reference, balances, payment proofs and history | Reopened as Reconciled. Ledger fingerprint and CSV fingerprint matched before and after restart. |
| Export history | Creation, both proofs and both allocation events | Five rows exported with manual and reference allocation distinguished. |

The two Phantom approvals used the local review helper. It uses an explicit Devnet chain through Wallet Standard and checks the saved payer and legacy transaction support. The configured invoice checkout now links to that helper as **Review in Phantom**. A separate Brave test is still needed for the generic Solana Pay URI. The verifier supports legacy and v0 with `maxSupportedTransactionVersion: 0`. [Wallet Standard signing contract](https://github.com/anza-xyz/wallet-standard/blob/master/packages/core/features/src/signAndSendTransaction.ts) · [Official Solana skill](https://github.com/solana-foundation/solana-dev-skill/tree/main/skills/solana-dev)

The submitted 30-USDC request previously left its disabled Review button on screen. The page now hides that action, displays the submission status, and advances to the referenced balance after assignment. A separate browser check exercised this transition and the narrow layout. The actual restarted page shows the settled state and offers the customer statement.

## Evidence files

- [42-second one-take Devnet receipt replay](output/playwright/hackathon-one-take-devnet-replay.webm). A fresh isolated ledger re-verified both finalized signatures through checkout and followed the integrated Phantom review links. Wallet approvals are from the original run. [Runbook](REHEARSAL.md)
- [47-second live Devnet recap](output/playwright/devnet-live-evidence-recap.webm) assembled from captured acceptance screens. Chrome playback and seeking passed.
- [Verified and unallocated](output/playwright/devnet-live-30-unallocated.png), [assignment preview](output/playwright/devnet-live-assignment-preview.png), [20 USDC due](output/playwright/devnet-live-20-due.png), [settled statement](output/playwright/devnet-live-settled.png), [signature replay](output/playwright/devnet-live-replayed.png), and [statement after restart](output/playwright/devnet-live-restarted.png).
- [Final history CSV](output/playwright/devnet-acceptance-history.csv), [final statement and history JSON](output/playwright/devnet-acceptance-statement.json), and [public proofs with restart comparison](output/playwright/devnet-acceptance-20261106.json).
- [66-second simulated rehearsal](output/playwright/workspace-recovery-demo-simulated.webm) from the separate QA ledger.

## Reopen the settled run

Run from `D:\solanaHackathon` with the saved receiver configured in `.env`.

```powershell
node --env-file-if-exists=.env scripts/devnet-acceptance.js serve
# In another terminal
node --env-file-if-exists=.env scripts/devnet-acceptance.js snapshot
```

The same isolated ledger opens on port 4175. The wallet review page on port 4177 displays settlement. [Customer statement](http://127.0.0.1:4175/pay/b02ea657-ca79-4c80-a8ce-f09d51cfcac8) · [Wallet review](http://127.0.0.1:4177/)

