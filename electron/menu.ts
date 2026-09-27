/**
 * U1: application menu. macOS needs a real menu with Edit roles or Cmd+C/V
 * stop working in the renderer (well-known Electron behavior; Tauri shipped
 * an equivalent default menu). Other platforms get no menu bar, matching the
 * Tauri window (which showed none on Windows/Linux).
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';

export function installAppMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      // Hardcoded: in dev the bundle is Electron.app, and macOS renders the
      // bold app-menu title from the bundle/process name — app.name may still
      // be 'Electron' there even with app.setName. Packaged builds get
      // productName ('Comate') from the bundle either way.
      label: 'Comate',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
