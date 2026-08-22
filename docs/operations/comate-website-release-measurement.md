# Comate website release and measurement runbook

This runbook separates code readiness from live deployment and measurement. An unchecked item or `TODO` value is an open gate, not a completed action. Record only aggregate GA4 values here or in an approved external report; never commit visitor-level analytics exports.

## Named owners and immutable measurement contract

- Release/measurement owner: `TODO — named person`
- Privacy/legal approver: `TODO — named person`
- Product owner for Retina/HiDPI evidence review: `TODO — named person`
- GA4 property: `TODO — property name/ID held outside git`
- Property timezone: `TODO — freeze before baseline`
- Internal/developer traffic filters: `TODO — record active filter names`
- Aggregate denominator: measured sessions
- Primary Key Event: `release_download_click`
- Event-scoped dimensions: `locale`, `cta_location`, `platform`, `destination_stage`
- Consent storage contract: version 1; analytics unknown/denied sends no Google request; all ad consent remains denied
- Low-volume rule: if either comparison window has fewer than 100 measured sessions or 20 Key Event sessions, extend both windows symmetrically by seven complete days, up to 42 days; otherwise record the capped result as inconclusive

Freeze the property, timezone, filters, dimensions, denominator, event definition, query, and attribution settings before baseline day 1. Do not change them between windows.

## Stage A — instrumentation on the unchanged site

- [ ] Privacy/legal approves the exact bilingual disclosure and consent behavior.
- [ ] A valid `PUBLIC_GA_MEASUREMENT_ID` is stored as a GitHub Actions repository variable; it is not committed.
- [ ] Record pre-U1 rollback target: `TODO — last known-good commit/deployment`.
- [ ] Deploy U1 consented analytics without the visual refresh.
- [ ] Same-day production checks pass: all platform links reach official GitHub Releases; accept sends only the allowlisted event; reject/no-choice sends zero Google requests; revoke stops future events and clears site-owned analytics state.
- [ ] Next-day GA4 standard reporting, Key Event marking, dimensions, and internal-traffic exclusion are verified.
- [ ] Record validated U1 rollback target: `TODO — commit/deployment`.
- [ ] Seven complete stabilization days finish: `TODO — start/end in property timezone`.

If privacy behavior fails, disable the Measurement ID immediately while preserving release navigation, then restore the pre-U1 deployment if needed.

## Stage B — freeze the pre-refresh baseline

- [ ] Baseline starts only after Stage A stabilization: `TODO — date/time`.
- [ ] Fourteen complete baseline days finish: `TODO — date/time`.
- [ ] Freeze aggregate values: measured sessions `TODO`; Key Event sessions `TODO`; Key Events `TODO`; Session Key Event rate `TODO`.
- [ ] Record the saved query/settings and instrumentation deployment annotation: `TODO — approved external location`.

Do not launch the visual refresh until this baseline is frozen.

## Stage C — launch refreshed site

- [ ] CI passes install, Astro check, Vitest, build, static verification, Playwright, and axe against the uploadable output.
- [ ] Product owner confirms product screenshots remain legible on mobile and a physical Retina/HiDPI display.
- [ ] Deploy refreshed site: `TODO — commit and timestamp`.
- [ ] Same-day production smoke repeats the Stage A link, consent, payload, base-path, responsive-image, and preference-revision checks.
- [ ] Next-day GA4 reporting and exclusions remain valid.
- [ ] Record launch annotation without changing the frozen measurement contract.

For a refresh regression, roll back to the validated U1 deployment. Pause and restart the affected post-launch window so it contains only valid complete days.

## Stage D — post-launch readout

- [ ] Fourteen complete post-launch days finish: `TODO — date/time`.
- [ ] Aggregate values: measured sessions `TODO`; Key Event sessions `TODO`; Key Events `TODO`; Session Key Event rate `TODO`.
- [ ] Compare absolute and relative rate change and event/session counts against the frozen baseline.
- [ ] Record known traffic/cohort differences, including new/returning where available, without claiming a GA4-derived consent rate.
- [ ] Apply the symmetric extension rule when required: `TODO — result, extension dates, or inconclusive`.
- [ ] Final outcome and decision: `TODO — result and follow-up owner/date`.

The refresh is code-ready when Stage C's local and CI gates pass. It is not measurement-complete until Stage D and any symmetric extension have ended.
