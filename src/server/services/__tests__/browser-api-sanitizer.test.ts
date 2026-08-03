import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_VERSION,
  brokerRequestSchema,
  captureStateSchema,
  sharedContractFixtures,
} from '@comate/api-contracts';
import {
  sanitizeBody,
  sanitizeHeaders,
  sanitizeUrl,
  serializeLogSafe,
} from '../browser-api-sanitizer.js';

const EXACT_SECRET = 'sentinel-exact-secret-7e458f0b';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.VeryLongSignatureForTestingOnly';

describe('browser API contract package', () => {
  it('accepts shared public fixtures and rejects another contract version', () => {
    assert.equal(CONTRACT_VERSION, 1);
    assert.equal(captureStateSchema.parse('recording'), 'recording');
    assert.equal(brokerRequestSchema.parse(sharedContractFixtures.brokerRequest).version, 1);
    assert.equal(
      brokerRequestSchema.safeParse({ ...sharedContractFixtures.brokerRequest, version: 2 }).success,
      false,
    );
  });
});

describe('browser API fail-closed sanitizer', () => {
  it('allows useful headers but structurally redacts credential and transport headers', () => {
    const result = sanitizeHeaders({
      accept: 'application/json',
      authorization: `Bearer ${EXACT_SECRET}`,
      cookie: `sid=${EXACT_SECRET}`,
      connection: 'keep-alive',
      'x-requested-with': 'fetch',
      'x-api-key': EXACT_SECRET,
    }, { exactSecrets: [EXACT_SECRET] });

    assert.deepEqual(result.value, {
      accept: 'application/json',
      authorization: '<auth:authorization>',
      cookie: '<auth:cookie>',
      'x-api-key': '<redacted:secret>',
      'x-requested-with': 'fetch',
    });
    assert.ok(result.receipt.redactions.length >= 4);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(EXACT_SECRET));
  });

  it('redacts URL query secrets by key, exact value, and token pattern', () => {
    const result = sanitizeUrl(
      `https://api.example.com/quota?access_token=${EXACT_SECRET}&opaque=${JWT}&page=2`,
      { exactSecrets: [EXACT_SECRET] },
    );

    assert.equal(result.value, 'https://api.example.com/quota?access_token=%3Credacted%3Asecret%3E&opaque=%3Credacted%3Atoken%3E&page=2');
    assert.equal(result.query.find((entry) => entry.name === 'page')?.value, '2');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(EXACT_SECRET));
    assert.doesNotMatch(JSON.stringify(result), /eyJhbGci/);
  });

  it('sanitizes nested JSON and GraphQL variables, including unfamiliar exact-secret keys', () => {
    const result = sanitizeBody({
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query: 'query Quota($token: String!) { quota(token: $token) { remaining } }',
        variables: { token: EXACT_SECRET, ordinary: 'visible' },
        unfamiliar: EXACT_SECRET,
        nested: { client_secret: 'another-secret', jwt: JWT },
      }),
      exactSecrets: [EXACT_SECRET],
    });

    assert.equal(result.class, 'graphql');
    assert.equal(result.receipt.disclosed, true);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(EXACT_SECRET));
    assert.doesNotMatch(serialized, /another-secret|eyJhbGci/);
    assert.match(serialized, /visible/);
  });

  it('sanitizes form fields and withholds ambiguous free text containing a token', () => {
    const form = sanitizeBody({
      contentType: 'application/x-www-form-urlencoded',
      body: `username=alice&password=${EXACT_SECRET}&note=hello`,
      exactSecrets: [EXACT_SECRET],
    });
    assert.equal(form.class, 'form');
    assert.doesNotMatch(JSON.stringify(form), new RegExp(EXACT_SECRET));

    const text = sanitizeBody({ contentType: 'text/plain', body: `result ${JWT}` });
    assert.equal(text.class, 'text');
    assert.equal(text.receipt.disclosed, false);
    assert.equal(text.receipt.withheldReason, 'ambiguous_sensitive_text');
    assert.equal(text.value, undefined);
  });

  it('withholds binary, multipart, unknown types, and invalid encodings', () => {
    const binary = sanitizeBody({ contentType: 'application/octet-stream', body: Buffer.from([0, 1]) });
    assert.equal(binary.class, 'binary');
    assert.equal(binary.receipt.withheldReason, 'binary_content');

    const multipart = sanitizeBody({ contentType: 'multipart/form-data; boundary=x', body: '--x' });
    assert.equal(multipart.class, 'multipart');
    assert.equal(multipart.receipt.withheldReason, 'multipart_content');

    const unknown = sanitizeBody({ contentType: 'application/x-private', body: 'anything' });
    assert.equal(unknown.class, 'unknown');
    assert.equal(unknown.receipt.withheldReason, 'unsupported_content_type');

    const absentType = sanitizeBody({ body: 'untyped response' });
    assert.equal(absentType.class, 'unknown');
    assert.equal(absentType.receipt.disclosed, false);

    const invalid = sanitizeBody({
      contentType: 'application/json; charset=made-up',
      body: '{"ok":true}',
    });
    assert.equal(invalid.class, 'invalid_encoding');
    assert.equal(invalid.receipt.withheldReason, 'unsupported_encoding');
  });

  it('fails closed on depth/member limits and explicitly marks safe truncation', () => {
    const deep = sanitizeBody({
      contentType: 'application/json',
      body: JSON.stringify({ a: { b: { c: { d: true } } } }),
      limits: { maxDepth: 2 },
    });
    assert.equal(deep.receipt.disclosed, false);
    assert.equal(deep.receipt.withheldReason, 'structure_limit_exceeded');

    const many = sanitizeBody({
      contentType: 'application/json',
      body: JSON.stringify({ a: 1, b: 2, c: 3 }),
      limits: { maxMembers: 2 },
    });
    assert.equal(many.receipt.disclosed, false);
    assert.equal(many.receipt.withheldReason, 'structure_limit_exceeded');

    const truncated = sanitizeBody({
      contentType: 'text/plain; charset=utf-8',
      body: 'abcdefghij',
      limits: { maxStringLength: 5 },
    });
    assert.equal(truncated.class, 'truncated');
    assert.equal(truncated.value, 'abcde');
    assert.equal(truncated.receipt.truncated, true);
  });

  it('does not serialize sentinels through the log-safe boundary', () => {
    const output = serializeLogSafe({
      url: `https://example.com/?token=${EXACT_SECRET}`,
      authorization: `Bearer ${EXACT_SECRET}`,
      nested: { value: EXACT_SECRET },
    }, { exactSecrets: [EXACT_SECRET] });
    assert.doesNotMatch(output, new RegExp(EXACT_SECRET));
    assert.match(output, /redacted/);
  });
});
