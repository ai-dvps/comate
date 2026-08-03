import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  brokerRequestSchema,
  brokerResultSchema,
  sharedContractFixtures,
} from '@comate/api-contracts';

describe('public contract fixtures', () => {
  it('parses the same broker request and result fixtures through the package entrypoint', () => {
    assert.equal(brokerRequestSchema.parse(sharedContractFixtures.brokerRequest).version, 1);
    assert.equal(brokerResultSchema.parse(sharedContractFixtures.brokerSuccess).ok, true);
  });

  it('rejects payloads from unknown versions', () => {
    assert.equal(
      brokerResultSchema.safeParse({ ...sharedContractFixtures.brokerSuccess, version: 999 }).success,
      false,
    );
  });
});
