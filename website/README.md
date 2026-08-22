# Comate website

The localized static site is built with Astro and published under `/comate` on GitHub Pages.

## Development

Run commands from this directory:

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
npm run test
npm run build
npm run test:e2e
npm run test:browser
```

The Playwright installation is a one-time prerequisite on a clean machine. Browser tests start `astro preview` without rebuilding, so they inspect the same `dist` output produced by the preceding build. The deploy workflow runs this complete sequence before it can upload a Pages artifact.

After that one-time install, `npm run verify` runs the same local check-through-browser sequence. Set `PUBLIC_GA_MEASUREMENT_ID` before it only when intentionally exercising a non-secret public test or production value.

## Consented analytics

Analytics is disabled when `PUBLIC_GA_MEASUREMENT_ID` is unset or invalid. Production receives this public value from the GitHub Actions repository variable with the same name. Do not commit a Measurement ID.

The site loads GA4 only after an explicit or persisted analytics grant. Rejecting, making no choice, or returning with a persisted denial loads no Google resource. Revoking consent persists denial, stops future site events, and removes known `_ga` cookies and site-owned analytics state; it cannot erase requests already sent before revocation. All ad consent remains denied, automatic page views are disabled, and events carry only enumerated locale, CTA location, platform, and destination-stage values. Download links never wait for analytics.

`release_download_click` is the sole primary Key Event and is reserved for outbound actions on the Download page. `download_cta_click` is diagnostic. Enhanced Measurement outbound clicks must remain outside KPI reporting.

Before enabling production measurement, the release owner must record the named measurement owner and privacy/legal approver outside this repository and obtain approval for the bilingual disclosure. Freeze an aggregate-only measurement specification containing:

- GA4 property and recorded timezone
- `release_download_click` Key Event and measured-session denominator
- event-scoped dimensions: locale, CTA location, platform, destination stage
- consent storage version, internal/developer filters, minimal retention, and exclusions
- instrumentation production commit and deployment time
- seven complete stabilization days and the 14-complete-day baseline start/end
- the symmetric low-volume rule: extend both windows in seven-day increments up to 42 days if either has fewer than 100 measured sessions or 20 key-event sessions; otherwise report the capped result as inconclusive

Do not store visitor-level analytics exports in git. Local checks do not establish live GA4 reporting, legal approval, or baseline completion.

The staged release, aggregate measurement record, production smoke checks, and two rollback targets are defined in [the website release and measurement runbook](../docs/operations/comate-website-release-measurement.md). Every unchecked item in that document is a release gate; the template must not be interpreted as evidence that a deployment or measurement window occurred.
