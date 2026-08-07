# Linux smoke checklist (U10 / R3 / KTD-5)

Audience: whoever validates a release candidate on Linux. Linux joined the
release matrix in U10: **AppImage is the primary artifact** (electron-updater
auto-update via `latest-linux.yml`), **deb is secondary** (updates need
privileges — see §5). There is no Tauri Linux install base, so no bridge
rehearsal exists here — this is a clean-install smoke gate (see
`bridge-rollback.md` §1c).

**Hard gate: every item below must pass on a real Ubuntu VM before the first
Electron release carrying Linux artifacts is published.** Code-level platform
differences were reviewed at implementation time (tray degradation, CDP /
partition / fingerprint paths, reveal IPC); what remains is exactly the
behavioral verification that needs a GUI.

## 0. Preconditions

- CI green on the release tag, including the `ubuntu-22.04` matrix leg
  (AppImage + deb + `latest-linux.yml` + blockmaps guarded by CI).
- Draft release carries: `Comate-X.Y.Z-linux-x86_64.AppImage`,
  `Comate-X.Y.Z-linux-x86_64.deb`, `latest-linux.yml`, `*.blockmap`
  (enterprise flavor: `Comate-X.Y.Z-enterprise-linux-x86_64.*` and
  `latest-enterprise-linux.yml`).
- Test machines:
  - **VM-A:** clean Ubuntu 22.04 LTS (GNOME, X11 or Wayland), no Comate ever
    installed.
  - **VM-B (edge):** minimal WM session (e.g. i3 / Openbox, or GNOME with
    no AppIndicator extension) — a desktop **without a status notifier host**.
  - Optional: a HiDPI display or `Settings > Displays > Scale` at 200%.

## 1. Happy path — AppImage on a clean VM (VM-A)

- [ ] Download the AppImage from the draft release, `chmod +x`, launch it.
      App starts, main window renders, no sandbox error (if the kernel blocks
      unprivileged user namespaces the AppImage needs `--no-sandbox` — record
      if that was necessary; it should NOT be on stock Ubuntu 22.04).
- [ ] Data dir assertion: `$XDG_DATA_HOME/com.comate.app` (or
      `~/.local/share/com.comate.app`) created; `shell/` subdir holds the
      Chromium profile (KTD-7 pinning).
- [ ] Create a workspace, start one session, confirm the agent runs
      (sidecar + bundled backend work under the AppImage).
- [ ] Tray: icon appears in the GNOME top bar (via AppIndicator), menu shows
      Open / WeCom bot status / Active sessions / Quit; status labels refresh
      (~5s poll).

## 2. Browser tools on Linux (VM-A)

- [ ] Open the embedded browser panel; `comate-browser open` navigates the
      in-shell Chromium view (shell CDP path — `/api/health/browser` reports
      no failure class).
- [ ] Run through the 11-tool core: open, snapshot, inspectElement,
      startNetworkCapture / stopNetworkCapture, authenticatedRequest, act,
      submit, extract, requestHandoff, close.
- [ ] Login persistence: log in to one site (remember-site), restart the app,
      confirm the session partition `persist:comate-browser-<sessionId>`
      under `~/.local/share/com.comate.app/shell/Partitions/` keeps state.
- [ ] Fingerprint spot-check: in the embedded browser, load a UA echo page —
      UA reports `X11; Linux x86_64` desktop Chrome and the real engine
      version (host-OS profile per U7; UA-CH platform must be `Linux`, never
      a macOS/Windows claim from a Linux window).

## 3. AppImage self-update (VM-A)

- [ ] With the app running X.Y.Z, serve/publish X.Y.(Z+1) (a re-serve of the
      same build under a bumped version is fine). Update check in the client
      discovers it from `latest-linux.yml`.
- [ ] Download completes (blockmap differential path exercised), install on
      quit relaunches the new version (`armUpdateGrace` 5s sidecar grace
      visible in logs).
- [ ] Post-update: workspace list, sessions, and site logins intact.

## 4. Edge — no-tray environment (VM-B)

- [ ] Launch the app under the minimal WM. Tray creation fails; the app logs
      `Failed to build system tray` and **keeps running** (no crash).
- [ ] Closing the main window **quits the app** (U10 degradation:
      close-to-hide would trap the window with no tray to reopen it from;
      `resolveWindowCloseAction` in `electron/tray.ts`). Relaunch works and
      data is intact.

## 5. deb path (VM-A)

- [ ] `sudo apt install ./Comate-X.Y.Z-linux-x86_64.deb` installs; app
      appears in the applications menu (desktop entry from
      `electron-builder.config.ts`: name, icon, `Utility` category,
      maintainer field valid).
- [ ] App runs from the deb install identically to §1-§2.
- [ ] **Documented limitation (KTD-5):** the deb build does NOT auto-update —
      applying an update requires root (`apt`/`dpkg` as sudo), so deb users
      update by downloading and reinstalling the new `.deb`. The in-app
      updater flow is supported on AppImage only. This caveat is documented
      in `development.md` § Building for Production.

## 6. HiDPI (VM-A, 200% scale)

- [ ] Browser panel view bounds recompute cleanly on scale change / window
      drag between monitors — no jitter, no offset view (U8 rect-reporting
      path; the shell forwards device-pixel rects to `setBounds`).

## 7. Platform-difference notes (reviewed at code level; confirm on VM)

- [ ] Reveal-in-file-manager: `comate:reveal-in-file-manager` opens the file
      manager. Item **highlight** depends on the file manager's
      org.freedesktop.FileManager1 DBus support — Nautilus highlights; some
      file managers only open the folder. Accepted difference (comment at
      `electron/main.ts` reveal handler). Record the VM's observed behavior.
- [ ] Dock badge: no-op on Linux by design (macOS-only feature; Windows
      flashes the taskbar instead).
- [ ] External-URL opening: `comate:open-url` opens the default browser via
      xdg-open semantics.

## Failure handling

Any §1-§5 failure on the VM matrix blocks the Linux artifacts: ship the
release without them (drop the ubuntu leg's publish) rather than publishing a
broken Linux line, and escalate to the migration owner. The macOS/Windows
legs are unaffected — matrix `fail-fast: false` keeps them independent.
