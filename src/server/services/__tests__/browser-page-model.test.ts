import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  RefTable,
  buildExtractorScript,
  buildSubmitSnapshotScript,
  diffPageModels,
  diffSubmitSnapshots,
  distillPageModel,
  estimateTokens,
  extractActionsFromAxTree,
  extractAlertsFromAxTree,
  isSensitiveField,
  sanitizeSubmitPayload,
  type PageModel,
  type PageModelSource,
  type RawAxNode,
  type RawPageExtraction,
  type SubmitSnapshot,
} from '../browser-page-model.js';

/**
 * browser-page-model tests — distiller, sensitivity ruleset (KTD-8), ref
 * batch discipline (KTD-3), and the submit TOCTOU helpers (KTD-4 ②).
 * The in-page extractor script is exercised structurally (it ships as a
 * string); its output is fed through canned RawPageExtraction fixtures.
 */

function makeExtraction(overrides: Partial<RawPageExtraction> = {}): RawPageExtraction {
  return {
    url: 'https://shop.example/checkout',
    title: 'Checkout',
    docId: 'doc-1',
    domEpoch: 0,
    forms: [
      {
        formIndex: 0,
        name: 'payment',
        action: 'https://shop.example/pay',
        method: 'post',
        fields: [
          {
            fieldIndex: 0,
            name: 'cardNumber',
            label: 'Card number',
            tag: 'input',
            type: 'text',
            required: true,
            autocomplete: 'cc-number',
            disabled: false,
            readOnly: false,
            sensitive: true,
            value: undefined,
            filled: true,
            submitSemantics: false,
            xpath: '/html[1]/body[1]/form[1]/input[1]',
          },
          {
            fieldIndex: 1,
            name: 'email',
            label: 'Email',
            tag: 'input',
            type: 'email',
            required: true,
            autocomplete: 'email',
            disabled: false,
            readOnly: false,
            sensitive: false,
            value: 'a@b.c',
            filled: true,
            submitSemantics: false,
            xpath: '/html[1]/body[1]/form[1]/input[2]',
          },
          {
            fieldIndex: 2,
            name: 'password',
            label: 'Password',
            tag: 'input',
            type: 'password',
            required: false,
            disabled: false,
            readOnly: false,
            sensitive: true,
            value: undefined,
            filled: false,
            submitSemantics: false,
            xpath: '/html[1]/body[1]/form[1]/input[3]',
          },
          {
            fieldIndex: 3,
            name: undefined,
            label: 'Pay now',
            tag: 'button',
            type: 'submit',
            required: false,
            disabled: false,
            readOnly: false,
            sensitive: false,
            value: undefined,
            filled: false,
            submitSemantics: true,
            xpath: '/html[1]/body[1]/form[1]/button[1]',
          },
        ],
      },
    ],
    standalone: [],
    contentText: 'Order summary: one very large anvil.',
    contentTruncated: false,
    alerts: [],
    stats: { linkCount: 5, buttonCount: 2, hasPasswordField: true },
    ...overrides,
  };
}

function makeAxNodes(): RawAxNode[] {
  return [
    { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, backendDOMNodeId: 1 },
    { nodeId: '2', ignored: false, role: { value: 'button' }, name: { value: 'Apply coupon' }, backendDOMNodeId: 22 },
    { nodeId: '3', ignored: false, role: { value: 'link' }, name: { value: 'Help' }, backendDOMNodeId: 33 },
    { nodeId: '4', ignored: true, role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 44 },
    { nodeId: '5', ignored: false, role: { value: 'button' }, name: { value: 'Duplicate backend' }, backendDOMNodeId: 22 },
    { nodeId: '6', ignored: false, role: { value: 'textbox' }, name: { value: 'Covered by forms' }, backendDOMNodeId: 55 },
    { nodeId: '7', ignored: false, role: { value: 'alert' }, name: { value: 'Card declined' }, backendDOMNodeId: 66 },
  ];
}

function fakeSource(extraction: RawPageExtraction, axNodes: RawAxNode[]): PageModelSource {
  return {
    evaluate: async <T>(expression: string): Promise<T> => {
      assert.ok(
        expression.includes('__comateProbe'),
        'distiller must evaluate the extractor script',
      );
      return extraction as T;
    },
    getFullAXTree: async () => axNodes,
  };
}

describe('browser-page-model sensitivity ruleset (KTD-8)', () => {
  it('marks type=password sensitive', () => {
    assert.strictEqual(isSensitiveField({ type: 'password', name: 'x' }), true);
    assert.strictEqual(isSensitiveField({ type: 'Password' }), true);
  });

  it('marks credential autocomplete tokens sensitive', () => {
    for (const autocomplete of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp']) {
      assert.strictEqual(isSensitiveField({ autocomplete }), true, autocomplete);
    }
    assert.strictEqual(isSensitiveField({ autocomplete: 'email' }), false);
    assert.strictEqual(isSensitiveField({ autocomplete: 'username' }), false);
  });

  it('marks credential-ish name/id/label sensitive', () => {
    assert.strictEqual(isSensitiveField({ name: 'user_password' }), true);
    assert.strictEqual(isSensitiveField({ id: 'cvv' }), true);
    assert.strictEqual(isSensitiveField({ name: 'card-number' }), true);
    assert.strictEqual(isSensitiveField({ label: 'Verification code' }), true);
    assert.strictEqual(isSensitiveField({ name: 'otp_token' }), true);
    assert.strictEqual(isSensitiveField({ name: 'email' }), false);
    assert.strictEqual(isSensitiveField({ name: 'address' }), false);
  });
});

describe('browser-page-model accessibility tree processing', () => {
  it('keeps only widget roles, skips ignored nodes, dedupes by backendNodeId', () => {
    const actions = extractActionsFromAxTree(makeAxNodes());
    assert.deepStrictEqual(
      actions.map((action) => [action.role, action.name, action.backendNodeId]),
      [
        ['button', 'Apply coupon', 22],
        ['link', 'Help', 33],
      ],
    );
  });

  it('caps the action list', () => {
    const nodes: RawAxNode[] = Array.from({ length: 100 }, (_, index) => ({
      nodeId: String(index),
      role: { value: 'button' },
      name: { value: `B${index}` },
      backendDOMNodeId: index + 1,
    }));
    assert.strictEqual(extractActionsFromAxTree(nodes, 40).length, 40);
  });

  it('extracts alert text from AX alert roles', () => {
    assert.deepStrictEqual(extractAlertsFromAxTree(makeAxNodes()), ['Card declined']);
  });
});

describe('browser-page-model distillation (KTD-3)', () => {
  it('distills forms/actions/content with sensitive values absent', async () => {
    const refTable = new RefTable();
    const model = await distillPageModel(fakeSource(makeExtraction(), makeAxNodes()), refTable);

    assert.strictEqual(model.url, 'https://shop.example/checkout');
    assert.strictEqual(model.pageType, 'login'); // hasPasswordField
    assert.strictEqual(model.forms.length, 1);
    assert.strictEqual(model.forms[0].fields.length, 4);

    const card = model.forms[0].fields[0];
    assert.strictEqual(card.sensitive, true);
    assert.strictEqual('value' in card, false, 'sensitive field value must be absent');

    const email = model.forms[0].fields[1];
    assert.strictEqual(email.sensitive, false);
    assert.strictEqual(email.value, 'a@b.c');

    const password = model.forms[0].fields[2];
    assert.strictEqual(password.sensitive, true);
    assert.strictEqual('value' in password, false);

    const payButton = model.forms[0].fields[3];
    assert.strictEqual(payButton.submitSemantics, true);

    assert.strictEqual(model.actions.length, 2);
    assert.ok(model.tokenEstimate > 0);
    // Model JSON must not contain any sensitive value anywhere.
    assert.ok(!JSON.stringify(model).includes('4111'), 'no raw card value in model');
  });

  it('defensively strips values the extractor mislabels as non-sensitive', async () => {
    const extraction = makeExtraction();
    // Extractor bug fixture: value present + sensitive flag false, but the
    // sidecar ruleset knows cc-number is sensitive.
    extraction.forms[0].fields[0].sensitive = false;
    extraction.forms[0].fields[0].value = '4111111111111111';
    const model = await distillPageModel(
      fakeSource(extraction, []),
      new RefTable(),
    );
    const card = model.forms[0].fields[0];
    assert.strictEqual('value' in card, false, 'sidecar ruleset re-check must strip the value');
  });

  it('marks over-budget content as truncated', async () => {
    const longText = 'x'.repeat(5000);
    const model = await distillPageModel(
      fakeSource(makeExtraction({ contentText: longText.slice(0, 4000), contentTruncated: true }), []),
      new RefTable(),
    );
    assert.strictEqual(model.content.truncated, true);
    assert.strictEqual(model.content.text.length, 4000);
  });

  it('mints refs with form/field/action semantics and invalidates the batch on DOM change', async () => {
    const refTable = new RefTable();
    const model = await distillPageModel(fakeSource(makeExtraction(), makeAxNodes()), refTable);
    const fieldRef = model.forms[0].fields[0].ref;
    const formRef = model.forms[0].ref;
    const actionRef = model.actions[0].ref;
    assert.ok(fieldRef && formRef && actionRef);
    assert.strictEqual(refTable.get(fieldRef)?.kind, 'field');
    assert.strictEqual(refTable.get(formRef)?.kind, 'form');
    assert.strictEqual(refTable.get(actionRef)?.kind, 'action');
    assert.strictEqual(refTable.get(actionRef)?.backendNodeId, 22);
    assert.strictEqual(refTable.get(fieldRef)?.submitSemantics, false);
    assert.strictEqual(refTable.get(formRef)?.formIndex, 0);

    assert.strictEqual(refTable.isCurrent(fieldRef, { docId: 'doc-1', domEpoch: 0 }), true);
    // DOM mutation bumps the epoch: the whole batch is dead.
    assert.strictEqual(refTable.isCurrent(fieldRef, { docId: 'doc-1', domEpoch: 1 }), false);
    // Navigation changes the document: the whole batch is dead.
    assert.strictEqual(refTable.isCurrent(fieldRef, { docId: 'doc-2', domEpoch: 0 }), false);
  });

  it('re-distillation replaces the batch wholesale', async () => {
    const refTable = new RefTable();
    const first = await distillPageModel(fakeSource(makeExtraction(), makeAxNodes()), refTable);
    const firstRef = first.actions[0].ref;
    await distillPageModel(
      fakeSource(makeExtraction({ domEpoch: 3 }), makeAxNodes()),
      refTable,
    );
    assert.strictEqual(refTable.get(firstRef), undefined, 'old refs are dropped with the batch');
  });

  it('exposes standalone controls as a synthetic form', async () => {
    const model = await distillPageModel(
      fakeSource(
        makeExtraction({
          forms: [],
          standalone: [
            {
              fieldIndex: -1,
              name: 'q',
              label: 'Search',
              tag: 'input',
              type: 'search',
              required: false,
              disabled: false,
              readOnly: false,
              sensitive: false,
              value: '',
              filled: false,
              submitSemantics: false,
              xpath: '/html[1]/body[1]/input[1]',
            },
          ],
          stats: { linkCount: 2, buttonCount: 0, hasPasswordField: false },
        }),
        [],
      ),
      new RefTable(),
    );
    assert.strictEqual(model.forms.length, 1);
    assert.strictEqual(model.forms[0].formIndex, -1);
    assert.strictEqual(model.forms[0].fields[0].label, 'Search');
  });

  it('classifies page types', async () => {
    const cases: Array<[Partial<RawPageExtraction>, string]> = [
      [{ forms: [], standalone: [], stats: { linkCount: 2, buttonCount: 0, hasPasswordField: false }, contentText: 'short' }, 'unknown'],
      [{ forms: [], standalone: [], stats: { linkCount: 2, buttonCount: 0, hasPasswordField: false }, contentText: 'y'.repeat(2000) }, 'article'],
      [{ forms: [], standalone: [], stats: { linkCount: 80, buttonCount: 0, hasPasswordField: false }, contentText: 'y'.repeat(2000) }, 'listing'],
    ];
    for (const [overrides, expected] of cases) {
      const model = await distillPageModel(
        fakeSource(makeExtraction(overrides), []),
        new RefTable(),
      );
      assert.strictEqual(model.pageType, expected);
    }
  });

  it('extractor script embeds the shared sensitivity constants', () => {
    const script = buildExtractorScript();
    assert.ok(script.includes('current-password'), 'exact autocomplete tokens embedded');
    assert.ok(script.includes('cc-'), 'cc- prefix embedded');
    assert.ok(script.includes('password'), 'password type check embedded');
    const snapshotScript = buildSubmitSnapshotScript(0);
    assert.ok(snapshotScript.includes('current-password'), 'TOCTOU script shares the ruleset');
  });

  it('estimateTokens scales with content size', async () => {
    const small = await distillPageModel(fakeSource(makeExtraction(), []), new RefTable());
    const large = await distillPageModel(
      fakeSource(makeExtraction({ contentText: 'z'.repeat(3000) }), []),
      new RefTable(),
    );
    assert.ok(estimateTokens(large) > estimateTokens(small));
  });
});

describe('browser-page-model deltas', () => {
  function baseModel(overrides: Partial<PageModel> = {}): PageModel {
    return {
      url: 'https://a.example/',
      title: 'A',
      pageType: 'unknown',
      forms: [],
      actions: [],
      content: { text: 'hello', truncated: false },
      alerts: [],
      tokenEstimate: 10,
      ...overrides,
    };
  }

  it('reports a full delta from no previous model', () => {
    const delta = diffPageModels(null, baseModel());
    assert.strictEqual(delta.pageChanged, true);
    assert.strictEqual(delta.urlChanged, true);
  });

  it('detects url/content/alert changes', () => {
    const prev = baseModel();
    const next = baseModel({
      url: 'https://b.example/',
      content: { text: 'world', truncated: false },
      alerts: ['boom'],
    });
    const delta = diffPageModels(prev, next);
    assert.strictEqual(delta.urlChanged, true);
    assert.strictEqual(delta.contentChanged, true);
    assert.deepStrictEqual(delta.alertsAdded, ['boom']);
    assert.strictEqual(delta.pageChanged, true);
  });

  it('reports no change for identical models', () => {
    const delta = diffPageModels(baseModel(), baseModel());
    assert.strictEqual(delta.pageChanged, false);
    assert.strictEqual(delta.contentChanged, false);
  });
});

describe('browser-page-model submit TOCTOU helpers (KTD-4 ②)', () => {
  function snapshot(overrides: Partial<SubmitSnapshot> = {}): SubmitSnapshot {
    return {
      action: 'https://shop.example/pay',
      method: 'post',
      fields: [
        { name: 'cardNumber', type: 'text', sensitive: true, value: 'h:deadbeef:16' },
        { name: 'email', type: 'email', sensitive: false, value: 'a@b.c' },
      ],
      ...overrides,
    };
  }

  it('sanitizes the confirmation payload: sensitive names only, values for the rest', () => {
    const payload = sanitizeSubmitPayload({
      url: 'https://shop.example/checkout',
      formName: 'payment',
      snapshot: snapshot(),
    });
    assert.strictEqual(payload.kind, 'browser_submit');
    assert.strictEqual(payload.actionOrigin, 'https://shop.example');
    const fields = payload.fields as Array<Record<string, unknown>>;
    const card = fields.find((field) => field.name === 'cardNumber');
    assert.ok(card);
    assert.strictEqual(card.sensitive, true);
    assert.strictEqual('value' in card, false, 'sensitive value (even hashed) stays out of the card');
    const email = fields.find((field) => field.name === 'email');
    assert.strictEqual(email?.value, 'a@b.c');
    // The serialized card must not contain the hash either.
    assert.ok(!JSON.stringify(payload).includes('deadbeef'));
  });

  it('diffs snapshots by change kind without values', () => {
    const approved = snapshot();
    const current = snapshot({
      action: 'https://evil.example/collect',
      fields: [
        { name: 'cardNumber', type: 'text', sensitive: true, value: 'h:0badf00d:16' },
        { name: 'email', type: 'email', sensitive: false, value: 'a@b.c' },
        { name: 'coupon', type: 'text', sensitive: false, value: 'SAVE10' },
      ],
    });
    const diffs = diffSubmitSnapshots(approved, current);
    assert.deepStrictEqual(
      diffs.map((diff) => `${diff.kind}${diff.field ? `:${diff.field}` : ''}`).sort(),
      ['action_changed', 'field_added:coupon', 'value_changed:cardNumber'],
    );
    assert.ok(!JSON.stringify(diffs).includes('0badf00d'), 'diffs never carry values');
  });

  it('detects removed fields and method changes', () => {
    const diffs = diffSubmitSnapshots(
      snapshot(),
      snapshot({ method: 'get', fields: [snapshot().fields[1]] }),
    );
    assert.deepStrictEqual(
      diffs.map((diff) => `${diff.kind}${diff.field ? `:${diff.field}` : ''}`).sort(),
      ['field_removed:cardNumber', 'method_changed'],
    );
  });

  it('matches identical snapshots', () => {
    assert.deepStrictEqual(diffSubmitSnapshots(snapshot(), snapshot()), []);
  });
});
