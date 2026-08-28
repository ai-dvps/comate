import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTOSTART_FILE_NAME = 'comate.desktop';

export function linuxAutostartFilePath(configHome: string): string {
  return join(configHome, 'autostart', AUTOSTART_FILE_NAME);
}

function escapeDesktopExecPath(executablePath: string): string {
  return executablePath.replace(/[\\"`$]/g, '\\$&');
}

export function getLinuxLaunchAtLogin(configHome: string): boolean {
  return existsSync(linuxAutostartFilePath(configHome));
}

export function setLinuxLaunchAtLogin(
  configHome: string,
  executablePath: string,
  enabled: boolean,
): void {
  const filePath = linuxAutostartFilePath(configHome);
  if (!enabled) {
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
  }

  mkdirSync(join(configHome, 'autostart'), { recursive: true });
  writeFileSync(
    filePath,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Comate',
      `Exec="${escapeDesktopExecPath(executablePath)}"`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o644 },
  );
}
