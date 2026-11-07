# Boothproof interface

The interface is a dark payment workspace with its own receipt mark and identity. It draws on the near-black surfaces, large typography, and selective color in [Solana's website](https://solana.com/), and the purple `#9945FF` and green `#14F195` in its [brand guide](https://solana.com/branding). The app identifies itself as an independent Devnet project.

## Audit and implementation

The previous interface used cream surfaces, a serif display face, small utilitarian controls, and a fundraiser illustration. The redesign makes the checkout and agency reconciliation screens feel like parts of one product:

- A shared dark token system defines surfaces, readable text, control boundaries, semantic colors, spacing, radii, shadows, motion, and stacking order in `public/styles.css`.
- Space Grotesk headings and Manrope interface text are self-hosted. The two Latin variable WOFF2 files total 46,820 bytes. Other writing systems use the system-font fallback. Each font's SIL Open Font License is included beside its file.
- Green marks verified credits and the primary action. Purple identifies navigation and pending work. Amber identifies exceptions. Icons and text accompany payment states.
- Forms, invoice balances, payment history, receipts, exports, and the field guide share the same visual language. QR codes retain a plain white background for scanning.
- Buttons expose an accessible busy state, preserve their original labels, and recover after a failed request. Existing payment and reconciliation handlers remain responsible for the actions.
- Motion includes staggered page/card entrances, floating decorative receipt art, button highlights, table-filter fades, and a one-time receipt confirmation when a payment settles. QR codes and token amounts remain stable. The footer's **Pause motion** control remembers the preference; system reduced-motion settings take precedence. Active browser animations are canceled when paused, hidden, or printing. Printed receipts use light surfaces.
- Tables have captions, named scroll regions, keyboard focus, and contained horizontal overflow on small screens.

## Spectrum UI MCP

The configured `spectrum-ui` server was connected through its stdio MCP transport. `tools/list` was inspected first; the returned schemas are in `spectrum-tools.json`. Searches covered invoice tables, status badges, statistics, loading buttons, and empty states. `get_component` supplied metadata and implementation references, and the corresponding registry source was inspected before implementation.

| Source | Native adaptation |
| --- | --- |
| [Invoices Table](https://ui.spectrumhq.in/r/invoices-table.json) | Monospaced invoice identifiers, semantic status labels, numeric columns, and accessible row actions. Uses the app's actual invoices and existing CSV export. |
| [Status Badge](https://ui.spectrumhq.in/r/status-badge.json) | Icon-and-text badges with inset borders and semantic dark backgrounds. |
| [Stat Cards](https://ui.spectrumhq.in/r/stat-cards.json) | Clear label/value hierarchy, restrained surfaces, and reduced-motion entry. Statistics use saved data; sample trends and chart engines are omitted. |
| [Loading Button](https://ui.spectrumhq.in/r/loading-button-dependencies.json) | Native disabled/busy behavior, loading indicator, and restored button content through `setButtonBusy`. |
| [Animated Card](https://ui.spectrumhq.in/r/animated-card.json) and [Skeleton Reveal](https://ui.spectrumhq.in/r/skeleton-reveal.json) | Hover feedback and opacity-based loading/reveal patterns, implemented with native CSS and the Web Animations API. The card fan-out and content blur are omitted to keep payment controls readable and stationary. |

Spectrum components are React/TypeScript and often depend on shadcn, Radix, or chart helpers. Installing their TSX files directly would not work in this application's native HTML/CSS/JavaScript stack. These are deliberately native adaptations, not installed React components. No frontend framework, animation library, or runtime dependency was added. Spectrum's [Apache 2.0 license](Spectrum-LICENSE.txt) is retained for these adaptations. `spectrum-sources.json` records the source URLs and SHA-256 values of the formatted registry JSON inspected on 2026-11-05.

## Verification

The existing automated payment, RPC, invoice, CSV, persistence, and request-security tests run with `npm.cmd test`. Static-font MIME, file signature, and conditional caching are also checked. Browser QA uses a separate ledger and includes checkout creation, payment exceptions, customer receipts, partial and excess invoice payments, imports, exports, validation feedback, and the Devnet wallet-request/signature-recovery screens. No funded wallet transaction is implied by that UI verification.

Responsive checks cover 320px, 360px, 768px, and desktop layouts. The invoice table scrolls with the keyboard and shows a visible focus ring. Key text and control colors are checked for contrast. All pages use the same theme, including empty and review states.
