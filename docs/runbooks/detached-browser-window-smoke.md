# Independent browser window smoke checklist

Run this checklist on each release platform after the automated Electron and client gates pass. Use a browser session with a recognizable page, an authenticated cookie, and—when practical—an OAuth-style popup.

## Shared lifecycle

- [ ] Choose **Open in independent window**. Exactly one normal top-level window opens; it is not always-on-top or parented to the main window.
- [ ] The originating panel keeps its width and names the owning chat. **Focus window** and **Back to panel** are keyboard reachable.
- [ ] Move, resize, minimize, and restore the independent window. The page remains aligned and retains its URL, cookie/login state, control mode, popup, and input shield ordering.
- [ ] Minimize the main window. The independent window remains separately available.
- [ ] Switch the main window to another chat. The independent window keeps its original chat, title, URL, and controls. Returning to the originating chat restores the placeholder.
- [ ] With session A detached, detach session B. A returns to its panel before B appears in the same independent window; no second independent browser window is created.
- [ ] Repeat detach/restore and A/B switching ten times. After settling, there is one browser page target per live session and no duplicate controls, popup views, or placement callbacks.

## Terminal and recovery paths

- [ ] Close the independent window using its OS close control. The same live page redocks without changing the main window's active chat.
- [ ] Use **Back to panel**. The page redocks and keyboard focus returns to the embedded viewer surface.
- [ ] Use **Close browser** in the independent window. The browser session ends and the independent window closes without briefly redocking the page.
- [ ] Trigger a child-renderer failure in a debug build. The live browser fails safe to the main window and the placement clears.
- [ ] Close the main window when a tray is available. The browser redocks before the application hides; reopening from the tray shows the embedded state.
- [ ] Quit explicitly and exercise update relaunch. Both windows close and no sidecar or renderer process remains.
- [ ] Load an external URL in the trusted independent-window frame. Navigation is blocked there and the URL opens in the system browser.

## Platform observations

### macOS

- [ ] The independent window has its own traffic-light controls and remains separate from the main window's minimize/close lifecycle.
- [ ] Closing the main window to the menu bar redocks before hiding; reopening from the menu bar preserves the page.

### Windows

- [ ] The independent window has its own taskbar entry and caption lifecycle.
- [ ] Main minimize does not minimize it; quit and update relaunch close both windows.

### Linux / Wayland

- [ ] The compositor exposes a separately manageable top-level window. Record semantic focus success; do not require forced foreground ordering.
- [ ] In a no-tray session, closing the main window quits safely and closes the independent window.

Sender-validation failures, simultaneous ownership in both windows, lost page/login state, or incorrect tray/quit behavior block release. Decoration and focus-animation differences are acceptable when the final semantic state is correct.
