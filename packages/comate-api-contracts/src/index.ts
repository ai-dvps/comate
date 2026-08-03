import { z } from 'zod';

/** The only wire version understood by this release. Unknown versions fail closed. */
export const CONTRACT_VERSION = 1 as const;
export const contractVersionSchema = z.literal(CONTRACT_VERSION);

const boundedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,128}$`));

export const captureIdSchema = boundedId('cap');
export const candidateIdSchema = boundedId('cand');
export const recipeIdSchema = boundedId('recipe');
export const authBindingSchema = boundedId('authb');

export const captureStateSchema = z.enum([
  'idle',
  'recording',
  'draining',
  'complete',
  'aborted',
]);

export const disclosureClassSchema = z.enum([
  'json',
  'graphql',
  'form',
  'text',
  'binary',
  'multipart',
  'unknown',
  'invalid_encoding',
  'truncated',
]);

export const withheldReasonSchema = z.enum([
  'binary_content',
  'multipart_content',
  'unsupported_content_type',
  'unsupported_encoding',
  'invalid_content',
  'ambiguous_sensitive_text',
  'structure_limit_exceeded',
  'decoded_size_exceeded',
  'sanitization_failed',
]);

export const redactionSchema = z.object({
  path: z.string().max(512),
  reason: z.enum(['credential_field', 'exact_secret', 'token_pattern', 'auth_header', 'transport_header']),
}).strict();

export const disclosureReceiptSchema = z.object({
  class: disclosureClassSchema,
  disclosed: z.boolean(),
  withheldReason: withheldReasonSchema.optional(),
  redactions: z.array(redactionSchema).max(512),
  originalBytes: z.number().int().nonnegative(),
  disclosedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().superRefine((receipt, context) => {
  if (receipt.disclosed === Boolean(receipt.withheldReason)) {
    context.addIssue({
      code: 'custom',
      message: 'withheldReason is required exactly when content is not disclosed',
    });
  }
});

export const sanitizedDisclosureSchema = z.object({
  class: disclosureClassSchema,
  mediaType: z.string().max(256).optional(),
  encoding: z.string().max(64).optional(),
  value: z.union([z.json(), z.string().max(65_536)]).optional(),
  receipt: disclosureReceiptSchema,
}).strict().superRefine((disclosure, context) => {
  if (disclosure.class !== disclosure.receipt.class) {
    context.addIssue({ code: 'custom', message: 'disclosure and receipt classes must match' });
  }
  if (disclosure.receipt.disclosed !== (disclosure.value !== undefined)) {
    context.addIssue({ code: 'custom', message: 'value is required exactly when content is disclosed' });
  }
});

export const sanitizedQueryEntrySchema = z.object({
  name: z.string().max(512),
  value: z.string().max(4096),
}).strict();

export const sanitizedCandidateSchema = z.object({
  version: contractVersionSchema,
  candidateId: candidateIdSchema,
  captureId: captureIdSchema,
  method: z.string().regex(/^[A-Z]+$/).max(16),
  url: z.string().url().startsWith('https://').max(8192),
  headers: z.record(z.string().max(256), z.string().max(4096)),
  query: z.array(sanitizedQueryEntrySchema).max(256),
  requestBody: sanitizedDisclosureSchema.optional(),
  response: z.object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string().max(256), z.string().max(4096)),
    body: sanitizedDisclosureSchema,
  }).strict(),
  evidence: z.object({
    action: z.string().max(1024),
    targetType: z.enum(['page', 'iframe', 'worker']),
    confidence: z.enum(['high', 'medium', 'low']),
  }).strict(),
  completeness: z.object({
    requestComplete: z.boolean(),
    responseComplete: z.boolean(),
    missing: z.array(z.string().max(128)).max(32),
  }).strict(),
}).strict();

export const recipeVariableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),
  location: z.enum(['path', 'query', 'header', 'body']),
  required: z.boolean(),
  description: z.string().max(1024).optional(),
}).strict();

export const apiRecipeSchema = z.object({
  version: contractVersionSchema,
  recipeId: recipeIdSchema,
  method: z.string().regex(/^[A-Z]+$/).max(16),
  url: z.string().url().startsWith('https://').max(8192),
  headers: z.record(z.string().max(256), z.string().max(4096)),
  query: z.array(sanitizedQueryEntrySchema).max(256),
  body: sanitizedDisclosureSchema.optional(),
  authBinding: authBindingSchema,
  variables: z.array(recipeVariableSchema).max(128),
  expectedResponseFields: z.array(z.string().max(512)).max(256),
  evidence: z.object({
    captureId: captureIdSchema,
    candidateId: candidateIdSchema,
    pageAction: z.string().max(1024),
  }).strict(),
  completeness: z.object({
    validated: z.boolean(),
    requestBodyAvailable: z.boolean(),
    responseBodyAvailable: z.boolean(),
  }).strict(),
  operationFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const brokerRequestSchema = z.object({
  version: contractVersionSchema,
  recipe: apiRecipeSchema,
  variables: z.record(z.string().max(128), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();

export const browserApiErrorCodeSchema = z.enum([
  'capture_already_active',
  'capture_not_active',
  'capture_aborted',
  'capture_incomplete',
  'remember_site_required',
  'unsupported_auth_source',
  'auth_not_applicable',
  'auth_binding_stale',
  'reauthentication_needed',
  'authorization_required',
  'authorization_denied',
  'authorization_expired',
  'destination_not_allowed',
  'destination_unsafe',
  'request_limit_exceeded',
  'response_withheld',
  'broker_unavailable',
  'audit_unavailable',
  'invalid_contract',
]);

export const browserApiErrorSchema = z.object({
  version: contractVersionSchema,
  ok: z.literal(false),
  code: browserApiErrorCodeSchema,
  message: z.string().max(1024),
  recovery: z.string().max(1024),
  retryable: z.boolean(),
}).strict();

export const brokerSuccessSchema = z.object({
  version: contractVersionSchema,
  ok: z.literal(true),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().max(256), z.string().max(4096)),
  body: sanitizedDisclosureSchema,
  approval: z.enum(['not_required', 'approved', 'task_grant']),
}).strict();

export const brokerResultSchema = z.discriminatedUnion('ok', [brokerSuccessSchema, browserApiErrorSchema]);

export type CaptureId = z.infer<typeof captureIdSchema>;
export type CaptureState = z.infer<typeof captureStateSchema>;
export type SanitizedCandidate = z.infer<typeof sanitizedCandidateSchema>;
export type ApiRecipe = z.infer<typeof apiRecipeSchema>;
export type OpaqueAuthBinding = z.infer<typeof authBindingSchema>;
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export type BrokerResult = z.infer<typeof brokerResultSchema>;
export type DisclosureReceipt = z.infer<typeof disclosureReceiptSchema>;
export type SanitizedDisclosure = z.infer<typeof sanitizedDisclosureSchema>;
export type BrowserApiError = z.infer<typeof browserApiErrorSchema>;

const fixtureReceipt = {
  class: 'json',
  disclosed: true,
  redactions: [],
  originalBytes: 18,
  disclosedBytes: 18,
  truncated: false,
} as const;

export const sharedContractFixtures = {
  brokerRequest: {
    version: CONTRACT_VERSION,
    recipe: {
      version: CONTRACT_VERSION,
      recipeId: 'recipe_12345678',
      method: 'GET',
      url: 'https://api.example.com/v1/quota',
      headers: { accept: 'application/json' },
      query: [{ name: 'account', value: '{{account}}' }],
      authBinding: 'authb_12345678',
      variables: [{ name: 'account', location: 'query', required: true }],
      expectedResponseFields: ['remaining'],
      evidence: {
        captureId: 'cap_12345678',
        candidateId: 'cand_12345678',
        pageAction: 'Open quota panel',
      },
      completeness: {
        validated: true,
        requestBodyAvailable: true,
        responseBodyAvailable: true,
      },
      operationFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    variables: { account: 'demo' },
  },
  brokerSuccess: {
    version: CONTRACT_VERSION,
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      class: 'json',
      mediaType: 'application/json',
      encoding: 'utf-8',
      value: { remaining: 42 },
      receipt: fixtureReceipt,
    },
    approval: 'not_required',
  },
} as const;
