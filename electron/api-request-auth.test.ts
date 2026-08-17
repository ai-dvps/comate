import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addSidecarAuthorization } from './api-request-auth';

describe('addSidecarAuthorization', () => {
  it('adds the desktop credential to media requests sent outside window.fetch', () => {
    assert.deepEqual(
      addSidecarAuthorization({}, 'desktop-secret'),
      { Authorization: 'Bearer desktop-secret' },
    );
  });

  it('preserves an explicit authorization header', () => {
    assert.deepEqual(
      addSidecarAuthorization({ authorization: 'Bearer explicit' }, 'desktop-secret'),
      { authorization: 'Bearer explicit' },
    );
  });
});
