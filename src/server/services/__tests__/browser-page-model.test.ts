import '../../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import {
  RefTable,
  buildPageState,
  buildExtractorScript,
  buildInspectElementStateFunction,
  buildActivationTargetSnapshotFunction,
  buildFileInputSnapshotFunction,
  buildInspectElementScript,
  buildSubmitSnapshotScript,
  diffPageModels,
  diffSubmitSnapshots,
  distillPageModel,
  estimateTokens,
  extractActionInventory,
  extractActionsFromAxTree,
  extractAlertsFromAxTree,
  isSensitiveField,
  sanitizeSubmitPayload,
  sameElementFingerprint,
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
        xpath: '/html[1]/body[1]/form[1]',
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
    getFullAXTree: async () => axNodes,
    getDocumentIdentity: () => ({
      targetId: 'target-1', sessionId: 'session-1', frameId: 'frame-1', loaderId: extraction.docId, generation: 0,
    }),
    extractPageModel: async () => ({
      extraction,
      backendNodeIds: [
        ...extraction.forms.flatMap((form) => [form, ...form.fields]),
        ...(extraction.standalone.length > 0 ? [{}] : []),
        ...extraction.standalone,
        ...(extraction.domCandidates ?? []),
      ].map((_item, index) => 100 + index),
    }),
    callBackendNode: async <T>(backendNodeId: number): Promise<T | null> => {
      const node = axNodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId);
      if (!node) return null;
      const role = String(node.role?.value ?? '').toLowerCase();
      const tag = role === 'link' ? 'a' : 'button';
      return { tag, type: tag === 'button' ? 'submit' : tag, role, editable: false, fileInput: false } as T;
    },
  };
}

function runExtractor(html: string): RawPageExtraction {
  const dom = new JSDOM(html, { url: 'https://creator.example/editor', runScripts: 'dangerously' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: function getClientRects() {
      const element = this as HTMLElement;
      return element.hidden || element.style.display === 'none' || element.hasAttribute('data-zero') ? [] : [element.getBoundingClientRect()];
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function getBoundingClientRect() {
      const element = this as HTMLElement;
      if (element.hidden || element.style.display === 'none' || element.hasAttribute('data-zero')) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
      }
      const index = Number(element.getAttribute('data-index') ?? 1);
      const left = index * 2;
      return { left, top: 10, right: left + 10, bottom: 30, width: 10, height: 20, x: left, y: 10, toJSON() {} };
    },
  });
  Object.defineProperty(window.document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => {
      const index = Math.round((x - 5) / 2);
      const target = window.document.querySelector(`[data-index="${index}"]`);
      return target?.hasAttribute('data-occluded') ? window.document.getElementById('overlay') : target;
    },
  });
  const extraction = window.eval(buildExtractorScript()) as RawPageExtraction;
  dom.window.close();
  return extraction;
}

describe('browser-page-model sensitivity ruleset (KTD-8)', () => {
  it('fails a bounded semantic fingerprint closed on tag/type/role/editable/file drift', () => {
    const expected = { tag: 'input', type: 'email', role: 'textbox', editable: true, fileInput: false };
    assert.equal(sameElementFingerprint(expected, expected), true);
    for (const changed of [
      { ...expected, tag: 'textarea' },
      { ...expected, type: 'file' },
      { ...expected, role: 'button' },
      { ...expected, editable: false },
      { ...expected, fileInput: true },
    ]) assert.equal(sameElementFingerprint(expected, changed), false);
  });
  it('builds a bounded positive-shape inspector with no raw HTML/value escape hatch', () => {
    const script = buildInspectElementScript({
      ref: 'e1-aa',
      kind: 'field',
      role: 'textbox',
      name: 'Email',
      batch: { targetId: 'target-1', sessionId: 'session-1', frameId: 'frame-1', loaderId: 'loader-1', generation: 0 },
      backendNodeId: 101,
      fingerprint: { tag: 'input', type: 'email', role: 'textbox', editable: true, fileInput: false },
      xpath: '/html/body/input[1]',
    });
    assert.match(script, /__comateInspectElement/);
    assert.match(script, /MAX_DESCENDANTS/);
    assert.match(script, /__comateSensitive/);
    assert.doesNotMatch(script, /outerHTML|innerHTML/);
    assert.doesNotMatch(script, /\.value\b/);
  });

  it('builds a lightweight page-state probe without descendant or form scans', () => {
    const script = buildInspectElementStateFunction();
    assert.match(script, /getBoundingClientRect/);
    assert.match(script, /elementFromPoint/);
    assert.doesNotMatch(script, /querySelectorAll|closest\(['"]form|outerHTML|innerHTML/);
  });

  it('activation snapshot fails visibility/enabled closed for hidden, inert, transparent, and ARIA states', () => {
    const dom = new JSDOM('<!doctype html><body><div id="parent"><button id="target">Go</button></div></body>', {
      url: 'https://example.test/editor',
      runScripts: 'outside-only',
    });
    const { window } = dom;
    const target = window.document.getElementById('target') as HTMLButtonElement;
    const parent = window.document.getElementById('parent') as HTMLElement;
    target.getBoundingClientRect = () => ({ x: 1, y: 2, width: 80, height: 20, top: 2, left: 1, right: 81, bottom: 22, toJSON: () => ({}) });
    Object.defineProperty(window.document, 'elementFromPoint', { value: () => target, configurable: true });
    const snapshotFn = window.eval(`(${buildActivationTargetSnapshotFunction()})`) as () => import('../browser-page-model.js').ActivationTargetSnapshot;
    const read = () => snapshotFn.call(target);

    assert.deepStrictEqual({ visible: read().visible, enabled: read().enabled }, { visible: true, enabled: true });
    target.style.opacity = '0';
    assert.strictEqual(read().visible, false);
    target.style.opacity = '1';
    parent.hidden = true;
    assert.strictEqual(read().visible, false);
    parent.hidden = false;
    parent.setAttribute('inert', '');
    assert.deepStrictEqual({ visible: read().visible, enabled: read().enabled }, { visible: false, enabled: false });
    parent.removeAttribute('inert');
    parent.setAttribute('aria-hidden', 'TRUE');
    assert.strictEqual(read().visible, false);
    parent.removeAttribute('aria-hidden');
    target.setAttribute('aria-disabled', ' TrUe ');
    assert.strictEqual(read().enabled, false);
    target.removeAttribute('aria-disabled');
    for (const [property, value] of [
      ['opacity', '0'],
      ['visibility', 'hidden'],
      ['pointerEvents', 'none'],
    ] as const) {
      parent.style[property] = value;
      assert.strictEqual(read().visible, false, `ancestor ${property}:${value} fails closed`);
      parent.style[property] = '';
    }
    dom.window.close();
  });

  it('accepts an associated visible label for a hidden file input and rejects directory semantics', () => {
    const dom = new JSDOM('<!doctype html><body><label for="media">Add image</label><input id="media" type="file" hidden accept="image/*"></body>', {
      url: 'https://example.test/editor', runScripts: 'outside-only',
    });
    const { window } = dom;
    const input = window.document.getElementById('media') as HTMLInputElement;
    const label = window.document.querySelector('label') as HTMLLabelElement;
    input.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) });
    label.getBoundingClientRect = () => ({ x: 1, y: 1, width: 80, height: 20, top: 1, left: 1, right: 81, bottom: 21, toJSON: () => ({}) });
    const snapshotFn = window.eval(`(${buildFileInputSnapshotFunction()})`) as () => import('../browser-page-model.js').FileInputSnapshot;
    const snapshot = snapshotFn.call(input);
    assert.equal(snapshot.fileInput, true);
    assert.equal(snapshot.associatedVisible, true);
    assert.equal(snapshot.accept, 'image/*');
    input.setAttribute('webkitdirectory', '');
    assert.equal(snapshotFn.call(input).directory, true);
  });

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
    assert.deepStrictEqual(
      { retained: extractActionInventory(nodes, 40).actions.length, total: extractActionInventory(nodes, 40).total },
      { retained: 40, total: 100 },
    );
  });

  it('preserves accessibility control states', () => {
    const [action] = extractActionsFromAxTree([{
      nodeId: 'button',
      role: { value: 'button' },
      name: { value: 'More' },
      backendDOMNodeId: 1,
      properties: [
        { name: 'disabled', value: { value: true } },
        { name: 'expanded', value: { value: 'false' } },
      ],
    }]);
    assert.deepStrictEqual(action.states, { disabled: true, expanded: 'false' });
  });

  it('extracts alert text from AX alert roles', () => {
    assert.deepStrictEqual(extractAlertsFromAxTree(makeAxNodes()), ['Card declined']);
  });
});

describe('browser-page-model distillation (KTD-3)', () => {
  it('extracts only useful visible DOM candidates and bounds large inventories', () => {
    const many = Array.from({ length: 2_100 }, (_, index) => `<div onclick="void 0" data-index="${index + 20}">Action ${index}</div>`).join('');
    const extraction = runExtractor(`<!doctype html><body>
      <div id="entry" style="cursor:pointer" data-index="1">写长文</div>
      <p data-index="2">ordinary paragraph</p>
      <div hidden onclick="void 0" data-index="3">hidden action</div>
      <div inert onclick="void 0" data-index="4">inert action</div>
      <div data-zero onclick="void 0" data-index="5">zero action</div>
      <div data-occluded onclick="void 0" data-index="6">occluded action</div>
      <div id="overlay"></div>
      <div style="cursor:pointer" data-index="7"></div>
      <div style="cursor:pointer" data-index="8">Parent <span style="cursor:pointer" data-index="9">Child action</span></div>
      ${many}
    </body>`);

    assert.ok(extraction.domCandidates?.some((candidate) => candidate.name === '写长文'));
    for (const rejected of ['ordinary paragraph', 'hidden action', 'inert action', 'zero action', 'occluded action']) {
      assert.ok(!extraction.domCandidates?.some((candidate) => candidate.name === rejected), rejected);
    }
    assert.strictEqual(extraction.domCandidates?.length, 200);
    assert.strictEqual(extraction.domCandidateInventory?.truncated, true);
    assert.strictEqual(extraction.domCandidates?.filter((candidate) => /Parent|Child action/.test(candidate.name)).length, 1);
    assert.ok(extraction.domCandidates?.some((candidate) => candidate.name === 'Child action'));
  });

  it('reserves the bounded scan for explicit controls after generic layout nodes', () => {
    const layout = Array.from({ length: 2_100 }, (_, index) =>
      `<div data-index="${index + 1}">Layout ${index}</div>`).join('');
    const extraction = runExtractor(`<!doctype html><body>${layout}
      <div onclick="void 0" data-index="2200">Late authoring action</div>
    </body>`);
    assert.ok(extraction.domCandidates?.some((candidate) => candidate.name === 'Late authoring action'));
  });

  it('extracts only the outer editable root and associated non-directory file input', () => {
    const sentinel = 'PRIVATE_ARTICLE_SENTINEL_中文_🚀';
    const extraction = runExtractor(`<!doctype html><body>
      <div contenteditable="true" aria-label="正文" data-index="1">${sentinel}<span contenteditable="true" aria-label="nested">子编辑器</span></div>
      <textarea aria-label="标题" data-index="2">short title</textarea>
      <label data-index="3">添加图片<input type="file" style="display:none" multiple accept="image/png,image/jpeg"></label>
      <input type="file" style="display:none" aria-label="unassociated">
      <label data-index="4">上传文件夹<input type="file" style="display:none" webkitdirectory></label>
    </body>`);

    assert.deepStrictEqual([...extraction.standalone].map((field) => field.label), ['标题', '添加图片', '正文']);
    const editable = extraction.standalone.filter((field) => field.contentLength !== undefined);
    assert.strictEqual(editable.length, 1);
    assert.strictEqual(editable[0].type, 'div');
    const upload = extraction.standalone.find((field) => field.type === 'file');
    assert.deepStrictEqual({ multiple: upload?.multiple, accept: upload?.accept }, { multiple: true, accept: 'image/png,image/jpeg' });
    assert.ok(!extraction.contentText.includes(sentinel));
    assert.ok(!JSON.stringify(extraction.domCandidates).includes(sentinel));
  });

  it('rebuilds once when candidate mapping crosses a document generation', async () => {
    const extraction = makeExtraction();
    let generation = 0;
    let extracts = 0;
    const source = fakeSource(extraction, []);
    source.getDocumentIdentity = () => ({
      targetId: 'target-1', sessionId: 'session-1', frameId: 'frame-1', loaderId: 'doc-1', generation,
    });
    source.extractPageModel = async () => {
      extracts += 1;
      if (extracts === 1) generation = 1;
      return {
        extraction,
        backendNodeIds: extraction.forms.flatMap((form) => [form, ...form.fields]).map((_item, index) => 100 + index),
      };
    };

    const model = await distillPageModel(source, new RefTable());
    assert.strictEqual(extracts, 2);
    assert.strictEqual(model.forms.length, 1);
  });

  it('merges bounded DOM actions by backend node with AX semantics winning', async () => {
    const extraction = makeExtraction({
      domCandidates: [
        {
          name: '写长文',
          context: '创作中心',
          tag: 'div',
          type: 'div',
          role: 'generic',
          xpath: '/html/body/div[1]',
        },
        {
          name: 'AX preferred name',
          context: 'duplicate fallback',
          tag: 'div',
          type: 'div',
          role: 'generic',
          xpath: '/html/body/div[2]',
        },
      ],
      domCandidateInventory: { total: 2, returned: 2, truncated: false },
    });
    const source = fakeSource(extraction, [{
      nodeId: 'ax-duplicate', role: { value: 'button' }, name: { value: 'AX preferred name' }, backendDOMNodeId: 106,
    }]);
    const refs = new RefTable();
    const model = await distillPageModel(source, refs);

    assert.deepStrictEqual(
      model.actions.map(({ name, role, provenance, interactionClass }) => ({ name, role, provenance, interactionClass })),
      [
        { name: 'AX preferred name', role: 'button', provenance: 'ax', interactionClass: 'ambiguous-activation' },
        { name: '写长文', role: 'generic', provenance: 'dom', interactionClass: 'ambiguous-activation' },
      ],
    );
    assert.strictEqual(model.actionInventory.total, 2);
    const domAction = model.actions.find((action) => action.provenance === 'dom');
    assert.strictEqual(domAction?.role, 'generic');
    assert.strictEqual(domAction ? refs.get(domAction.ref)?.fingerprint.role : undefined, '');
  });

  it('bounds concurrent CDP fingerprint requests for dense action inventories', async () => {
    const nodes: RawAxNode[] = Array.from({ length: 40 }, (_, index) => ({
      nodeId: `action-${index}`,
      role: { value: 'button' },
      name: { value: `Action ${index}` },
      backendDOMNodeId: 500 + index,
    }));
    const source = fakeSource(makeExtraction(), nodes);
    let active = 0;
    let maxActive = 0;
    source.callBackendNode = async <T>(): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { tag: 'button', type: 'button', role: 'button', editable: false, fileInput: false } as T;
    };
    const model = await distillPageModel(source, new RefTable(), { maxActions: 40 });
    assert.equal(model.actions.length, 40);
    assert.ok(maxActive > 1);
    assert.ok(maxActive <= 12, `observed ${maxActive} concurrent fingerprint calls`);
  });

  it('never downgrades page links, buttons, or consent controls from fail-closed activation', async () => {
    const model = await distillPageModel(fakeSource(makeExtraction(), [
      { nodeId: 'link', role: { value: 'link' }, name: { value: 'https://example.test/local' }, backendDOMNodeId: 201 },
      { nodeId: 'button', role: { value: 'button' }, name: { value: 'Preview' }, backendDOMNodeId: 202 },
      { nodeId: 'consent', role: { value: 'button' }, name: { value: 'Authorize OAuth consent' }, backendDOMNodeId: 203 },
    ]), new RefTable());
    assert.deepStrictEqual(model.actions.map(({ role, interactionClass }) => ({ role, interactionClass })), [
      { role: 'link', interactionClass: 'ambiguous-activation' },
      { role: 'button', interactionClass: 'ambiguous-activation' },
      { role: 'button', interactionClass: 'human-only' },
    ]);
  });

  it('models outer editable roots and associated file inputs without echoing long-form text', async () => {
    const sentinel = 'PRIVATE_ARTICLE_SENTINEL_中文_🚀';
    const extraction = makeExtraction({
      forms: [],
      standalone: [
        {
          fieldIndex: -1, label: '正文', tag: 'div', type: 'div', role: 'textbox',
          required: false, disabled: false, readOnly: false, visible: true, inViewport: true,
          sensitive: false, filled: true, contentLength: sentinel.length, submitSemantics: false,
          xpath: '/html/body/div[1]',
        },
        {
          fieldIndex: -1, label: '添加图片', tag: 'input', type: 'file', role: 'button',
          required: false, disabled: false, readOnly: false, visible: false, inViewport: false,
          sensitive: false, filled: false, submitSemantics: false, multiple: true, accept: 'image/png,image/jpeg',
          xpath: '/html/body/input[1]',
        },
      ],
      contentText: sentinel,
      contentTruncated: false,
      sourceInventory: { formCount: 0, fieldCount: 2 },
      stats: { linkCount: 0, buttonCount: 1, hasPasswordField: false },
    });
    const model = await distillPageModel(fakeSource(extraction, []), new RefTable());
    const fields = model.forms[0].fields;

    assert.deepStrictEqual(fields.map(({ label, role, interactionClass }) => ({ label, role, interactionClass })), [
      { label: '正文', role: 'textbox', interactionClass: 'edit' },
      { label: '添加图片', role: 'button', interactionClass: 'file-egress' },
    ]);
    assert.strictEqual(fields[0].filled, true);
    assert.strictEqual(fields[0].contentLength, sentinel.length);
    assert.strictEqual('value' in fields[0], false);
    assert.strictEqual(fields[1].multiple, true);
    assert.strictEqual(fields[1].accept, 'image/png,image/jpeg');
    assert.ok(!JSON.stringify(model).includes(sentinel));
  });

  it('classifies human-gated fields as handoff-only', async () => {
    const extraction = makeExtraction();
    extraction.forms[0].fields.push({
      fieldIndex: 4, label: 'Preview', tag: 'button', type: 'button', required: false,
      disabled: false, readOnly: false, sensitive: false, filled: false,
      submitSemantics: false, xpath: '/html[1]/body[1]/form[1]/button[2]',
    });
    const model = await distillPageModel(fakeSource(extraction, []), new RefTable());
    assert.strictEqual(model.forms[0].fields.find((field) => field.name === 'cardNumber')?.interactionClass, 'human-only');
    assert.strictEqual(model.forms[0].fields.find((field) => field.name === 'password')?.interactionClass, 'human-only');
    assert.strictEqual(model.forms[0].fields.find((field) => field.name === 'email')?.interactionClass, 'edit');
    assert.strictEqual(model.forms[0].fields.find((field) => field.label === 'Pay now')?.interactionClass, 'html-submit');
    assert.strictEqual(model.forms[0].fields.find((field) => field.label === 'Preview')?.interactionClass, 'ambiguous-activation');
  });

  it('maps the exact extracted objects without an XPath identity re-query', async () => {
    const extraction = makeExtraction();
    const source = {
      getFullAXTree: async () => [],
      getDocumentIdentity: () => ({
        targetId: 'target-1', sessionId: 'session-1', frameId: 'frame-1', loaderId: 'doc-1', generation: 0,
      }),
      extractPageModel: async () => ({
        extraction,
        backendNodeIds: [100, 101, 102, 103, 104],
      }),
      resolveBackendNodeIds: async (): Promise<Array<number | null>> => {
        throw new Error('XPath identity re-query must not run after extraction');
      },
    } as PageModelSource & {
      extractPageModel: () => Promise<{ extraction: RawPageExtraction; backendNodeIds: number[] }>;
    };

    const model = await distillPageModel(source, new RefTable());
    assert.equal(model.forms[0].fields[0].ref.startsWith('e'), true);
  });

  it('builds a revisioned semantic outline and a bounded element inventory', async () => {
    const axNodes: RawAxNode[] = [
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['main'] },
      { nodeId: 'main', role: { value: 'main' }, name: { value: 'Checkout' }, parentId: 'root', childIds: ['heading', 'button'] },
      { nodeId: 'heading', role: { value: 'heading' }, name: { value: 'Order summary' }, parentId: 'main' },
      { nodeId: 'button', role: { value: 'button' }, name: { value: 'Apply coupon' }, backendDOMNodeId: 22, parentId: 'main' },
    ];
    const model = await distillPageModel(fakeSource(makeExtraction(), axNodes), new RefTable());

    assert.match(model.pageRevision, /^[a-f0-9]{12}$/);
    assert.deepStrictEqual(
      model.outline.map(({ role, name, depth }) => ({ role, name, depth })),
      [
        { role: 'main', name: 'Checkout', depth: 0 },
        { role: 'heading', name: 'Order summary', depth: 1 },
        { role: 'button', name: 'Apply coupon', depth: 1 },
      ],
    );
    assert.strictEqual(model.outline[2].ref, model.actions[0].ref);
    assert.deepStrictEqual(model.actionInventory, { total: 1, returned: 1, truncated: false });
    assert.deepStrictEqual(model.outlineInventory, { total: 3, returned: 3, truncated: false });

    const state = buildPageState(model, { limit: 3, includeContent: false });
    assert.strictEqual(state.totalElements, 6);
    assert.strictEqual(state.elements.length, 3);
    assert.strictEqual(state.truncated, true);
    assert.strictEqual(state.nextOffset, 3);
    assert.strictEqual('content' in state, false);
    assert.ok(state.elements.some((element) => element.kind === 'form'));
    assert.ok(state.elements.some((element) => element.kind === 'field'));
  });

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

  it('reports when the page has more actions than the bounded model returns', async () => {
    const nodes: RawAxNode[] = Array.from({ length: 45 }, (_, index) => ({
      nodeId: String(index),
      role: { value: 'button' },
      name: { value: `Action ${index}` },
      backendDOMNodeId: index + 1,
    }));
    const model = await distillPageModel(fakeSource(makeExtraction(), nodes), new RefTable());
    assert.deepStrictEqual(model.actionInventory, { total: 45, returned: 40, truncated: true });
    assert.strictEqual(buildPageState(model).truncated, true);
  });

  it('reports semantic-outline and source extraction truncation', async () => {
    const nodes: RawAxNode[] = Array.from({ length: 90 }, (_, index) => ({
      nodeId: String(index),
      role: { value: 'heading' },
      name: { value: `Heading ${index}` },
    }));
    const extraction = makeExtraction({ sourceInventory: { formCount: 12, fieldCount: 400 } });
    const model = await distillPageModel(fakeSource(extraction, nodes), new RefTable());
    assert.deepStrictEqual(model.outlineInventory, { total: 90, returned: 80, truncated: true });
    assert.deepStrictEqual(model.sourceInventory.forms, { total: 12, returned: 1, truncated: true });
    assert.deepStrictEqual(model.sourceInventory.fields, { total: 400, returned: 4, truncated: true });
    assert.strictEqual(buildPageState(model).truncated, true);
  });

  it('caps page-controlled strings in the text-only state', async () => {
    const extraction = makeExtraction({ url: `https://example.test/${'u'.repeat(3000)}`, title: 't'.repeat(500) });
    extraction.forms[0].name = 'f'.repeat(500);
    const state = buildPageState(await distillPageModel(fakeSource(extraction, []), new RefTable()));
    assert.strictEqual(state.url.length, 2048);
    assert.strictEqual(state.title.length, 300);
    assert.strictEqual(state.elements[0].name.length, 160);
  });

  it('mints backend-node refs that survive unrelated same-document DOM churn', async () => {
    const refTable = new RefTable();
    const model = await distillPageModel(fakeSource(makeExtraction(), makeAxNodes()), refTable);
    const fieldRef = model.forms[0].fields[0].ref;
    const formRef = model.forms[0].ref;
    const actionRef = model.actions[0].ref;
    assert.ok(fieldRef && formRef && actionRef);
    assert.strictEqual(refTable.get(fieldRef)?.kind, 'field');
    assert.strictEqual(refTable.get(formRef)?.kind, 'form');
    assert.deepEqual(refTable.get(formRef)?.fingerprint, {
      tag: 'form', type: 'form', role: 'form', editable: false, fileInput: false,
    });
    assert.strictEqual(refTable.get(actionRef)?.kind, 'action');
    assert.strictEqual(refTable.get(actionRef)?.backendNodeId, 22);
    assert.strictEqual(refTable.get(fieldRef)?.submitSemantics, false);
    assert.strictEqual(refTable.get(formRef)?.formIndex, 0);
    assert.match(fieldRef, /^e\d+-[a-f0-9]{16}$/, 'refs include a collision-resistant batch nonce');

    const nextModel = await distillPageModel(fakeSource(makeExtraction(), makeAxNodes()), refTable);
    assert.notStrictEqual(
      nextModel.forms[0].fields[0].ref,
      fieldRef,
      'a new distillation batch cannot alias the previous batch ref',
    );
    assert.strictEqual(refTable.get(fieldRef), undefined, 'the previous batch ref is removed');

    const currentFieldRef = nextModel.forms[0].fields[0].ref;
    const identity = { targetId: 'target-1', sessionId: 'session-1', frameId: 'frame-1', loaderId: 'doc-1', generation: 0 };
    assert.strictEqual(refTable.isCurrent(currentFieldRef, identity), true);
    assert.strictEqual(refTable.isCurrent(currentFieldRef, identity), true, 'unrelated DOM churn does not alter CDP document identity');
    assert.strictEqual(refTable.isCurrent(currentFieldRef, { ...identity, loaderId: 'doc-2', generation: 1 }), false);
    assert.equal(refTable.get(currentFieldRef)?.backendNodeId, 101);
  });

  it('normalizes common implicit and explicit field roles', async () => {
    const extraction = makeExtraction();
    const base = extraction.forms[0].fields[1];
    extraction.forms[0].fields = [
      { ...base, fieldIndex: 0, type: 'number', label: 'Quantity' },
      { ...base, fieldIndex: 1, type: 'range', label: 'Volume' },
      { ...base, fieldIndex: 2, type: 'search', label: 'Search' },
      { ...base, fieldIndex: 3, tag: 'select', type: 'select', multiple: true, label: 'Tags' },
      { ...base, fieldIndex: 4, type: 'checkbox', role: 'switch', label: 'Enabled' },
    ];
    const model = await distillPageModel(fakeSource(extraction, []), new RefTable());
    assert.deepStrictEqual(
      model.forms[0].fields.map((field) => field.role),
      ['spinbutton', 'slider', 'searchbox', 'listbox', 'switch'],
    );
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
      pageRevision: 'revision',
      pageType: 'unknown',
      outline: [],
      outlineInventory: { total: 0, returned: 0, truncated: false },
      forms: [],
      actions: [],
      actionInventory: { total: 0, returned: 0, truncated: false },
      sourceInventory: {
        forms: { total: 0, returned: 0, truncated: false },
        fields: { total: 0, returned: 0, truncated: false },
      },
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
