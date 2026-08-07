import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildDesktopFingerprint,
  buildFingerprintInitScript,
  parseChromeVersion,
  userAgentOverrideParams,
} from '../browser-fingerprint.js';

/**
 * KTD-12 fingerprint builder shape (the live injection parity is proven
 * against real Chromium in scripts/test-shell-cdp.ts A5).
 */
describe('browser-fingerprint (KTD-12)', () => {
  it('parseChromeVersion reads product and UA strings', () => {
    assert.equal(parseChromeVersion('Chrome/151.0.7922.34'), '151.0.7922.34');
    assert.equal(
      parseChromeVersion('Mozilla/5.0 (Macintosh) Chrome/150.1.2.3 Safari/537.36'),
      '150.1.2.3',
    );
    // Note: the headless UA's frozen x.0.0.0 version DOES parse — callers must
    // prefer Browser.getVersion's product field over the UA (connectShellPage
    // does), which carries the full version.
    assert.equal(parseChromeVersion('HeadlessChrome/151.0.0.0'), '151.0.0.0');
  });

  it('builds a host-matched desktop UA with the real engine version', () => {
    const mac = buildDesktopFingerprint({ platform: 'darwin', arch: 'arm64', chromeVersion: '151.0.7922.34' });
    assert.match(mac.userAgent, /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) /);
    assert.match(mac.userAgent, /Chrome\/151\.0\.7922\.34 Safari\/537\.36$/);
    assert.equal(mac.userAgentMetadata.platform, 'macOS');
    assert.equal(mac.userAgentMetadata.architecture, 'arm');
    assert.equal(mac.navigator.platform, 'MacIntel');

    const win = buildDesktopFingerprint({ platform: 'win32', arch: 'x64', chromeVersion: '151.0.7922.34' });
    assert.match(win.userAgent, /Windows NT 10\.0; Win64; x64/);
    assert.equal(win.userAgentMetadata.platform, 'Windows');
    assert.equal(win.userAgentMetadata.architecture, 'x86');

    const linux = buildDesktopFingerprint({ platform: 'linux', chromeVersion: '151.0.7922.34' });
    assert.match(linux.userAgent, /X11; Linux x86_64/);
    // Unknown platforms fall back to the linux profile (Steel's default OS).
    const weird = buildDesktopFingerprint({ platform: 'freebsd', chromeVersion: '151.0.7922.34' });
    assert.equal(weird.userAgentMetadata.platform, 'Linux');
  });

  it('UA override params carry the Steel-shape userAgentMetadata', () => {
    const fp = buildDesktopFingerprint({ platform: 'darwin', arch: 'arm64', chromeVersion: '151.0.7922.34' });
    const params = userAgentOverrideParams(fp);
    assert.equal(params['userAgent'], fp.userAgent);
    assert.equal(params['acceptLanguage'], 'en-US,en');
    assert.equal(params['platform'], 'MacIntel');
    const meta = params['userAgentMetadata'] as Record<string, unknown>;
    const brands = meta['brands'] as Array<{ brand: string; version: string }>;
    assert.deepEqual(brands.map((b) => b.brand), ['Not/A)Brand', 'Chromium', 'Google Chrome']);
    assert.equal(brands[1]?.version, '151');
    const full = meta['fullVersionList'] as Array<{ brand: string; version: string }>;
    assert.equal(full.find((b) => b.brand === 'Google Chrome')?.version, '151.0.7922.34');
    assert.equal(meta['mobile'], false);
    assert.equal(meta['bitness'], '64');
  });

  it('init script is guarded, pins the navigator surface, and strips driver tells', () => {
    const fp = buildDesktopFingerprint({ platform: 'darwin', arch: 'arm64', chromeVersion: '151.0.7922.34' });
    const script = buildFingerprintInitScript(fp);
    assert.match(script, /__comateFingerprintApplied/);
    assert.match(script, /webdriver/);
    assert.match(script, /cdc_adoQpoAZQpn9p_Array/);
    assert.match(script, /\$cdc_asdjflasutopfhvcZLmcfl_/);
    assert.match(script, /MacIntel/);
    assert.match(script, /Google Inc\./);
    assert.match(script, /userAgentData/);
    assert.match(script, /getHighEntropyValues/);
    assert.match(script, /151\.0\.7922\.34/);
    // JSON payloads are embedded — no template placeholder can leak through.
    assert.ok(!script.includes('${'), 'init script contains an unevaluated placeholder');
  });
});
