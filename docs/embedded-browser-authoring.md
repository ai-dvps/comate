# Embedded browser authoring

The embedded browser can drive generic dynamic authoring interfaces without site-specific selectors:

- `getPageState` and `findElements` combine accessibility data with a bounded visible-DOM fallback.
- `act` edits input, textarea, select, checkbox/radio, and outer contenteditable fields. It never dispatches page clicks.
- `upload` assigns approved image/video files from the current workspace to a discovered file input. It is available only for the desktop shell-owned view.
- `activate` performs one physical click on a page-supplied action after a target-bound user approval.
- `submit` remains the specialized, separately approved HTML-form path.

Mutation tools require a caller-stable operation ID. Their receipts distinguish `not_dispatched`, `dispatched_verified`, and `outcome_unknown`; a dispatch receipt is not proof that a remote site completed its business operation. After upload or activation, observe fresh page state before drawing that conclusion. Never retry an `outcome_unknown` mutation automatically.

File upload accepts only bounded workspace-relative media paths. Absolute paths, traversal, dotfiles, symlinks, hard links, special files, extension/signature mismatches, page accept mismatches, external CDP targets, and changed post-approval sources fail closed. Approved bytes are copied from an open source handle into private process-owned staging and retained only for the bounded assignment/activation lifecycle or TTL.

Login, CAPTCHA, OTP, authorization/consent, payment, directory upload, and any other human-only control remain handoff steps. The browser does not use private site APIs, arbitrary page JavaScript, or site-specific selectors.

## Release acceptance

The deterministic gates, privacy-safe evidence format, and supervised real-site procedure live in [browser-acceptance.md](./browser-acceptance.md). That procedure intentionally uses semantic observation rather than page-specific labels or selectors.
