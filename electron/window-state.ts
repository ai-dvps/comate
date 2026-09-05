import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rectangle } from 'electron';

/** Work areas are ordered with the primary display first for disconnected monitors. */
export function loadWindowState(path: string, workAreas: Rectangle[]): Rectangle | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const { x, y, width, height } = value as Rectangle;
    if (![x, y, width, height].every(Number.isSafeInteger) || width < 480 || height < 600) {
      return undefined;
    }
    // Prefer the display containing the largest part of the saved window.
    let area = workAreas[0];
    if (!area) return undefined;
    let largestOverlap = 0;
    for (const candidate of workAreas) {
      const overlap = Math.max(0, Math.min(x + width, candidate.x + candidate.width) - Math.max(x, candidate.x))
        * Math.max(0, Math.min(y + height, candidate.y + candidate.height) - Math.max(y, candidate.y));
      if (overlap > largestOverlap) {
        largestOverlap = overlap;
        area = candidate;
      }
    }
    const restoredWidth = Math.min(width, area.width);
    const restoredHeight = Math.min(height, area.height);
    return {
      x: Math.max(area.x, Math.min(x, area.x + area.width - restoredWidth)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - restoredHeight)),
      width: restoredWidth,
      height: restoredHeight,
    };
  } catch {
    // Missing/corrupt preferences must never prevent the app from opening.
    return undefined;
  }
}

export function saveWindowState(path: string, bounds: Rectangle): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(bounds), 'utf8');
  renameSync(temporaryPath, path);
}
