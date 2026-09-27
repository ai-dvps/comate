# Product evidence captures

These images show the current Comate desktop renderer with a staged, entirely synthetic finance scenario. They are product evidence, not conceptual mockups.

## Capture method

- Source: the current `src/client` React application and its real Zustand stores, components, message renderer, permission surface, task panel, Tailwind theme, and responsive shell.
- Runtime: the repository Vite client rendered in headless Chromium at `1440 × 900`, device scale factor `1`, light theme, and English UI. The capture harness imported the real workspace and chat stores through Vite and injected only the fixture state described below.
- Limitation: this is a deterministic renderer fixture, not a packaged Electron binary connected to a live model, IM tenant, Skill Market, or internal data service. Native packaging chrome and real service responses are therefore outside the evidence shown. The visible product UI itself is rendered from the current Electron client source rather than recreated for the website.
- Full frames: `1440 × 900` WebP.
- Detail crops: `960 × 600` WebP. Request, progress, report, and notification use source crop `(430, 40, 960, 600)`; approval uses `(430, 260, 960, 600)` so the real permission surface remains legible.
- Encoding: `cwebp -q 82 -metadata none`. Intermediate PNG files are intentionally not committed.

To reproduce the capture, start the current client with `npm run dev:client -- --host 127.0.0.1`, open it with Playwright Chromium using the viewport above, import `/src/client/stores/workspace-store.ts` and `/src/client/stores/chat-store.ts`, and seed the five stage records below. Capture PNG frames with Playwright, then encode the full frames and documented crops with `cwebp`. Keep the filenames and dimensions stable so `src/assets-contract.test.ts` detects accidental drift.

## Synthetic fixture

- Organization/workspace: `Northstar Finance`
- Task: `FIN-042 · August finance brief`
- Request: consolidate August revenue and costs by region, analyze variance, and publish a brief
- Approved capabilities: `finance-data-approved` and `publish-internal-report`
- Synthetic figures: revenue `¥18.42M`, operating cost `¥11.07M`, and West variance `−3.4% vs plan`
- Synthetic restricted path: `/Northstar/Finance/Restricted/West-Forecast.xlsx`
- Reserved report URL: `https://reports.northstar.example/FIN-042`
- No customer names, production identifiers, real credentials, real network locations, or real financial values are present.

## Asset inventory and alt-text keys

| Key | Full frame | Detail crop | Purpose |
| --- | --- | --- | --- |
| `request` | `finance-request.webp` | `finance-request-detail.webp` | IM request and immediate task acknowledgement |
| `progress` | `finance-progress.webp` | `finance-progress-detail.webp` | Approved Skill/data access and visible progress |
| `approval` | `finance-approval.webp` | `finance-approval-detail.webp` | Restricted-data permission decision |
| `report` | `finance-report.webp` | `finance-report-detail.webp` | Analysis findings and report publication |
| `notification` | `finance-notification.webp` | `finance-notification-detail.webp` | Final IM completion summary and report link |

Localized `zh` and `en` alt text for these keys lives beside the Home/Usage integration in `src/components/ProductEvidence.astro`. Features entries carry paired localized alt text in their own MDX frontmatter. Informative images must keep descriptive alt text; no current crop is decorative.

## Redaction and visual review

- [x] Capture author checked every full-resolution frame for credentials, customer data, local usernames, real file paths, live service URLs, and hidden browser content.
- [x] Reserved `.example` reporting URL used; all organization, task, Skill, path, and finance values are synthetic.
- [x] Metadata stripped and per-image size budget enforced by the asset contract test.
- [x] Independent Codex reviewer checked all five full-resolution frames and confirmed that Northstar, FIN-042, finance values, paths, Skills, and the `.example` URL are synthetic, with no visible credential, local username, customer data, production identifier, or real network address.
- [x] Mobile-width browser review confirms that evidence cards preserve their aspect ratio, captions, and natural image dimensions while loading on scroll.
- [ ] Product owner confirms image and small-text legibility on a physical Retina/HiDPI display.

The remaining physical-display check is a release gate; this README does not claim it has occurred.
