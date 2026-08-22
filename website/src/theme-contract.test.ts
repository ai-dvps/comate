import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('.', import.meta.url));

describe('website color roles', () => {
  it('separates the blue-cyan brand palette from orange conversion actions', async () => {
    const styles = await readFile(path.join(srcRoot, 'styles/global.css'), 'utf8');

    expect(styles).toContain('--color-accent-hsl: 221 78% 31%');
    expect(styles).toContain('--color-accent-secondary-hsl: 190 78% 53%');
    expect(styles).toContain('--color-conversion-hsl: 24 95% 38%');
    expect(styles).toContain('--color-bg-hsl: 222 47% 7%');
    expect(styles).toContain('--color-conversion-hsl: 25 96% 59%');
  });

  it('reserves conversion color for primary download actions', async () => {
    const downloadSurfaces = await Promise.all([
      'Nav.astro',
      'MobileNav.astro',
      'HeroSection.astro',
      'CTASection.astro',
      'FeaturesContent.astro',
      'UsageContent.astro',
      'DownloadPanel.astro',
    ].map((name) => readFile(path.join(srcRoot, 'components', name), 'utf8')));

    for (const source of downloadSurfaces) {
      expect(source).toContain('bg-conversion');
      expect(source).toContain('hover:bg-conversion-hover');
    }
  });
});
