import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isTrustedUiUrl } from './trusted-ui-url';

const DEV = { uiScheme: 'app.comate', isPackaged: false };
const PACKAGED = { uiScheme: 'app.comate', isPackaged: true };

describe('trusted UI URL validation', () => {
  it('accepts only the exact bundled UI host', () => {
    assert.equal(isTrustedUiUrl('app.comate://localhost/index.html?window=detached-browser', PACKAGED), true);
    assert.equal(isTrustedUiUrl('app.comate://localhost@evil.example/index.html', PACKAGED), false);
    assert.equal(isTrustedUiUrl('app.comate://localhost.evil.example/index.html', PACKAGED), false);
    assert.equal(isTrustedUiUrl('app.comate://localhost:5173/index.html', PACKAGED), false);
  });

  it('accepts the exact Vite origin only in development', () => {
    assert.equal(isTrustedUiUrl('http://localhost:5173/?window=detached-browser', DEV), true);
    assert.equal(isTrustedUiUrl('http://localhost:5173@evil.example/', DEV), false);
    assert.equal(isTrustedUiUrl('http://localhost:5174/', DEV), false);
    assert.equal(isTrustedUiUrl('not a url', DEV), false);
    assert.equal(isTrustedUiUrl('http://localhost:5173/', PACKAGED), false);
  });
});
