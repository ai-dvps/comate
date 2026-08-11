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

## Manual Xiaohongshu acceptance

Run this only after the generic shell and Electron CDP gates pass:

1. Open `https://www.xiaohongshu.com/explore` in the embedded browser and complete login/CAPTCHA manually if requested.
2. Ask the agent to find “写长文”. Confirm it appears as a DOM-derived ambiguous activation, then approve the app-owned activation manifest.
3. Ask the agent to fill a Chinese title and a multi-paragraph body containing emoji and newlines. Verify the body is present in the site editor but absent from tool receipts and approval payloads.
4. Place a small PNG/JPEG in the workspace. Ask the agent to upload it through the discovered file-input ref and approve the file-egress manifest. Verify only the relative name, media type, size, total, and parsed page origin appear.
5. Ask the agent to find the final publish-like action. Review and approve its activation manifest, then independently inspect fresh page state to determine whether the site accepted, rejected, or requested more user input.
6. If login, CAPTCHA, consent, moderation, or account verification appears, use human handoff. Do not treat those controls as automation failures.

This checklist validates visible behavior only. It intentionally contains no production selector, private endpoint, or promise to bypass platform defenses.
