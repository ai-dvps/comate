import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('.', import.meta.url));
const websiteRoot = path.resolve(srcRoot, '..');
const productRoot = path.join(websiteRoot, 'public/images/product');
const featuresRoot = path.join(srcRoot, 'content/features');

const assetContract = [
  ['finance-request.webp', 1440, 900],
  ['finance-progress.webp', 1440, 900],
  ['finance-approval.webp', 1440, 900],
  ['finance-report.webp', 1440, 900],
  ['finance-notification.webp', 1440, 900],
  ['finance-request-detail.webp', 960, 600],
  ['finance-progress-detail.webp', 960, 600],
  ['finance-approval-detail.webp', 960, 600],
  ['finance-report-detail.webp', 960, 600],
  ['finance-notification-detail.webp', 960, 600],
] as const;

function readWebpDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');

  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  expect(chunk.trim()).toBe('VP8');
  const marker = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
  expect(marker).toBeGreaterThan(0);
  return {
    width: bytes.readUInt16LE(marker + 3) & 0x3fff,
    height: bytes.readUInt16LE(marker + 5) & 0x3fff,
  };
}

async function featureSources(locale: 'en' | 'zh-CN') {
  const directory = path.join(featuresRoot, locale);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.mdx')).sort();
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(path.join(directory, name), 'utf8') })));
}

describe('product evidence asset contract', () => {
  it('uses the desktop app icon as the shared website brand source', async () => {
    const [brandLogo, nav, footer, layout, redirect] = await Promise.all([
      readFile(path.join(srcRoot, 'components/BrandLogo.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'components/Nav.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'components/Footer.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'layouts/BaseLayout.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'pages/index.astro'), 'utf8'),
    ]);

    expect(brandLogo).toContain("import appIcon from '../../../build/icon.png'");
    expect(nav).toContain('<BrandLogo />');
    expect(footer).toContain('<BrandLogo size={28} />');
    expect(layout).toContain("import appIcon from '../../../build/icon.png'");
    expect(layout).toContain('rel="apple-touch-icon"');
    expect(redirect).toContain("import appIcon from '../../../build/icon.png'");
    expect([nav, footer].join('\n')).not.toContain('<rect x="3" y="3"');
  });

  it('keeps optimized WebP assets within the declared dimension and byte budgets', async () => {
    await Promise.all(assetContract.map(async ([name, width, height]) => {
      const bytes = await readFile(path.join(productRoot, name));
      expect(bytes.byteLength, `${name} exceeds the 150 KB per-image budget`).toBeLessThanOrEqual(150 * 1024);
      expect(readWebpDimensions(bytes), name).toEqual({ width, height });
    }));

    const committedImages = (await readdir(productRoot)).filter((name) => /\.(?:png|jpe?g|webp)$/i.test(name));
    expect(committedImages.sort()).toEqual(assetContract.map(([name]) => name).sort());
  });

  it('uses current product evidence instead of placeholder feature art in both locales', async () => {
    const [english, chinese] = await Promise.all([featureSources('en'), featureSources('zh-CN')]);
    expect(english.map(({ name }) => name)).toEqual(chinese.map(({ name }) => name));

    for (const entries of [english, chinese]) {
      for (const { name, source } of entries) {
        expect(source, name).not.toContain('/images/features/');
        expect(source, name).toMatch(/^image: \/comate\/images\/product\/finance-(?:request|progress|approval|report|notification)-detail\.webp$/m);
        const alt = source.match(/^imageAlt: (.+)$/m)?.[1]?.trim();
        expect(alt, `${name} needs meaningful localized alt text`).toBeTruthy();
        expect(alt, name).not.toMatch(/^(?:screenshot|截图|.+ screenshot)$/i);
      }
    }
  });

  it('declares responsive dimensions and bilingual alt text for every evidence stage', async () => {
    const [component, screenshot, home, usage] = await Promise.all([
      readFile(path.join(srcRoot, 'components/ProductEvidence.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'components/ProductScreenshot.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'components/HomeContent.astro'), 'utf8'),
      readFile(path.join(srcRoot, 'components/UsageContent.astro'), 'utf8'),
    ]);

    for (const key of ['request', 'progress', 'approval', 'report', 'notification']) {
      const block = component.match(new RegExp(`key: '${key}',[\\s\\S]*?(?=\\n  \\{|\\n\\] as const)`))?.[0];
      expect(block, `missing ${key} evidence key`).toBeTruthy();
      expect(block, `${key} needs Chinese alt text`).toMatch(/alt:\s*\{[\s\S]*?zh:\s*'[^']+'/);
      expect(block, `${key} needs English alt text`).toMatch(/alt:\s*\{[\s\S]*?en:\s*'[^']+'/);
    }

    expect(screenshot).toContain('<picture>');
    expect(screenshot).toContain('width={width}');
    expect(screenshot).toContain('height={height}');
    expect(screenshot).toContain('type="image/webp"');
    expect(home).toContain('<ProductEvidence locale={locale} />');
    expect(usage).toContain('<ProductEvidence locale={locale} variant="usage" />');
  });
});
