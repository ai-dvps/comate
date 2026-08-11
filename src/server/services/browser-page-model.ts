/**
 * browser-page-model — the distiller behind the comate-browser tool surface
 * (KTD-3). Turns a live page into a token-budgeted PageModel: accessibility
 * tree actions with stable element refs, form/field structure, and a
 * readability-lite main-text extraction. Raw DOM never enters the model.
 *
 * Sensitivity ruleset (KTD-8, shared with submit confirmation payloads and
 * U5's state diff): `type=password`, `autocomplete` in
 * {current-password, new-password, one-time-code} or prefixed `cc-`, and a
 * name/id/aria-label regex. Sensitive fields are marked `sensitive` and their
 * values NEVER leave the page — the in-page extractor hashes them and drops
 * the raw value before the CDP response is even built.
 *
 * Ref discipline: refs (`e1..eN`) are minted per distillation batch and carry
 * semantics (role + name) in the model text. A batch is keyed by
 * {docId, domEpoch} — docId changes on navigation, domEpoch on any structural
 * DOM mutation — so after a DOM change the whole batch is invalid and act/
 * submit return a structured stale-ref error instead of acting on ghosts.
 */

import { randomBytes } from 'node:crypto';
import { originOf } from './browser-origin.js';

// ---------------------------------------------------------------------------
// Sensitivity ruleset (KTD-8). These constants are interpolated verbatim into
// the in-page extractor script so page-side and sidecar-side classification
// can never drift apart.
// ---------------------------------------------------------------------------

export const SENSITIVE_AUTOCOMPLETE_EXACT: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
];
export const SENSITIVE_AUTOCOMPLETE_PREFIXES: readonly string[] = ['cc-'];
export const SENSITIVE_NAME_PATTERN =
  /pass(word|phrase)?|pwd|secret|token|api[-_]?key|cvv|cvc|ccv|card[-_ ]?(num(ber)?)?|ssn|otp|2fa|auth[-_ ]?code|verification[-_ ]?code/i;

export interface SensitiveFieldSpec {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
}

/** Sidecar-side mirror of the in-page sensitivity check (same constants). */
export function isSensitiveField(spec: SensitiveFieldSpec): boolean {
  if ((spec.type ?? '').toLowerCase() === 'password') return true;
  const autocomplete = (spec.autocomplete ?? '').toLowerCase().trim();
  if (SENSITIVE_AUTOCOMPLETE_EXACT.includes(autocomplete)) return true;
  if (SENSITIVE_AUTOCOMPLETE_PREFIXES.some((prefix) => autocomplete.startsWith(prefix))) return true;
  const haystack = [spec.name, spec.id, spec.label].filter(Boolean).join(' ');
  return SENSITIVE_NAME_PATTERN.test(haystack);
}

// In-page twin of isSensitiveField, generated from the shared constants.
const IN_PAGE_SENSITIVE_FN = `function __comateSensitive(el) {
  var type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  var ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
  if (${JSON.stringify(SENSITIVE_AUTOCOMPLETE_EXACT)}.indexOf(ac) !== -1) return true;
  var prefixes = ${JSON.stringify(SENSITIVE_AUTOCOMPLETE_PREFIXES)};
  for (var i = 0; i < prefixes.length; i++) { if (ac.indexOf(prefixes[i]) === 0) return true; }
  var hay = [el.getAttribute('name'), el.id, el.getAttribute('aria-label')].filter(Boolean).join(' ');
  return ${SENSITIVE_NAME_PATTERN.toString()}.test(hay);
}`;

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export type PageType = 'login' | 'form' | 'article' | 'listing' | 'unknown';

export interface PageModelField {
  ref: string;
  /** Form-structural identity; never a value. */
  name?: string;
  label: string;
  tag: string;
  type: string;
  /** Normalized accessibility-style role used by discovery and ref metadata. */
  role: string;
  required: boolean;
  sensitive: boolean;
  autocomplete?: string;
  /** Present only for non-sensitive fields, capped in length. */
  value?: string;
  /** True for type=submit/image and in-form buttons (KTD-4 classification). */
  submitSemantics: boolean;
}

export interface PageModelForm {
  ref: string;
  formIndex: number;
  name?: string;
  action?: string;
  method: string;
  fields: PageModelField[];
}

export interface PageModelAction {
  ref: string;
  role: string;
  name: string;
  backendNodeId: number;
}

export interface PageModel {
  url: string;
  title: string;
  pageType: PageType;
  forms: PageModelForm[];
  actions: PageModelAction[];
  content: { text: string; truncated: boolean };
  alerts: string[];
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Ref table — one per browser session; a whole batch invalidates together.
// ---------------------------------------------------------------------------

export interface RefBatchKey {
  docId: string;
  domEpoch: number;
}

export type RefKind = 'form' | 'field' | 'action';

export interface RefEntry {
  ref: string;
  kind: RefKind;
  /** Semantics for errors and confirmation payloads (role + name). */
  role: string;
  name: string;
  batch: RefBatchKey;
  /** action refs: resolve via DOM.resolveNode. */
  backendNodeId?: number;
  /** field/form refs: resolve via XPath in-page. */
  xpath?: string;
  formIndex?: number;
  fieldIndex?: number;
  submitSemantics?: boolean;
}

export interface InspectedElementChild {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface InspectedElementForm {
  name?: string;
  method: string;
  action?: string;
  fields: Array<{
    name?: string;
    label?: string;
    tag: string;
    type?: string;
    required: boolean;
    sensitive: boolean;
    filled: boolean;
  }>;
  truncated: boolean;
}

export interface InspectedElement {
  tag: string;
  role?: string;
  name?: string;
  attributes: Record<string, string>;
  nearbyText?: string;
  descendants: InspectedElementChild[];
  descendantsTruncated: boolean;
  form?: InspectedElementForm;
  actions: string[];
}

export class RefTable {
  private entries = new Map<string, RefEntry>();
  private batch: RefBatchKey | null = null;
  private counter = 0;
  /**
   * Per-batch nonce baked into every ref string (e.g. `e7-a1b2c3d4e5f60708`). Without it a
   * ref from an old batch could alias a different element minted at the same
   * counter position in the new batch, silently acting on the wrong node.
   */
  private nonce = '0000000000000000';

  get batchKey(): RefBatchKey | null {
    return this.batch;
  }

  /** Start a fresh batch keyed by the current document + DOM epoch. */
  beginBatch(batch: RefBatchKey): void {
    this.batch = batch;
    this.entries.clear();
    this.counter = 0;
    this.nonce = randomBytes(8).toString('hex');
  }

  clear(): void {
    this.entries.clear();
    this.batch = null;
    this.counter = 0;
  }

  mint(entry: Omit<RefEntry, 'ref' | 'batch'>): RefEntry {
    if (!this.batch) {
      throw new Error('RefTable.beginBatch must be called before minting refs');
    }
    this.counter += 1;
    const full: RefEntry = { ...entry, ref: `e${this.counter}-${this.nonce}`, batch: this.batch };
    this.entries.set(full.ref, full);
    return full;
  }

  get(ref: string): RefEntry | undefined {
    return this.entries.get(ref);
  }

  /**
   * Check whether a ref is safe for a mutation that requires an exact
   * document + DOM-epoch match with the batch that minted it.
   */
  isCurrent(ref: string, current: RefBatchKey): boolean {
    const entry = this.entries.get(ref);
    if (!entry) return false;
    return entry.batch.docId === current.docId && entry.batch.domEpoch === current.domEpoch;
  }
}

const INSPECT_MAX_TEXT = 600;
const INSPECT_MAX_DESCENDANTS = 12;
const INSPECT_MAX_FORM_FIELDS = 20;

/** Function declaration used both by Runtime.evaluate and backend-node callFunctionOn. */
export function buildInspectElementFunction(): string {
  return `function __comateInspectElement() {
  ${IN_PAGE_SENSITIVE_FN}
  var root = this;
  var MAX_TEXT = ${INSPECT_MAX_TEXT};
  var MAX_DESCENDANTS = ${INSPECT_MAX_DESCENDANTS};
  var MAX_FORM_FIELDS = ${INSPECT_MAX_FORM_FIELDS};
  if (!root || !root.tagName) return null;
  function cap(value, limit) { return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit); }
  function textWithoutFields(node, limit) {
    var output = '', walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && output.length < limit) {
      var parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"]')) continue;
      output += ' ' + (walker.currentNode.textContent || '');
    }
    return cap(output, limit);
  }
  function labelFor(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return cap(aria, 160);
    if (el.labels && el.labels.length) return cap(el.labels[0].textContent, 160);
    return '';
  }
  var allowed = ['href','action','method','type','name','role','aria-label','aria-expanded','aria-controls','placeholder','title','target'];
  var attributes = {};
  for (var ai = 0; ai < allowed.length; ai++) {
    var attr = allowed[ai], attrValue = root.getAttribute(attr);
    if (attrValue !== null && attr !== 'value') attributes[attr] = cap(attrValue, 300);
  }
  var all = Array.prototype.slice.call(root.querySelectorAll('*'));
  var descendants = [];
  for (var di = 0; di < all.length && descendants.length < MAX_DESCENDANTS; di++) {
    var child = all[di];
    if (!child.tagName || child.matches('script,style,noscript,[hidden],[aria-hidden="true"]')) continue;
    var sensitive = __comateSensitive(child);
    var item = { tag: child.tagName.toLowerCase() };
    var childRole = child.getAttribute('role');
    var childName = labelFor(child) || child.getAttribute('name');
    if (childRole) item.role = cap(childRole, 80);
    if (childName) item.name = cap(childName, 160);
    var childText = sensitive ? '' : textWithoutFields(child, 180);
    if (childText) item.text = childText;
    descendants.push(item);
  }
  var form = root.tagName.toLowerCase() === 'form' ? root : root.closest('form');
  var formSummary;
  if (form) {
    var controls = Array.prototype.slice.call(form.querySelectorAll('input,textarea,select,button'));
    formSummary = {
      method: cap(form.getAttribute('method') || 'get', 16).toLowerCase(),
      fields: [],
      truncated: controls.length > MAX_FORM_FIELDS
    };
    var formName = form.getAttribute('name') || form.id;
    var formAction = form.getAttribute('action');
    if (formName) formSummary.name = cap(formName, 160);
    if (formAction) formSummary.action = cap(formAction, 300);
    for (var fi = 0; fi < controls.length && fi < MAX_FORM_FIELDS; fi++) {
      var field = controls[fi], fieldSensitive = __comateSensitive(field);
      var summary = {
        tag: field.tagName.toLowerCase(),
        required: field.hasAttribute('required'),
        sensitive: fieldSensitive,
        filled: fieldSensitive ? field.hasAttribute('data-comate-filled') : field.hasAttribute('value')
      };
      var fieldName = field.getAttribute('name');
      var fieldType = field.getAttribute('type');
      var fieldLabel = labelFor(field);
      if (fieldName) summary.name = cap(fieldName, 160);
      if (fieldType) summary.type = cap(fieldType, 40);
      if (fieldLabel) summary.label = fieldLabel;
      formSummary.fields.push(summary);
    }
  }
  var tag = root.tagName.toLowerCase(), actions = [];
  if (tag === 'a' || tag === 'button' || root.getAttribute('role') === 'button') actions.push('click');
  if (tag === 'input' || tag === 'textarea') actions.push('fill');
  if (tag === 'select') actions.push('select');
  if (tag === 'input' && /^(checkbox|radio)$/i.test(root.getAttribute('type') || '')) actions.push('check');
  var rootType = (root.getAttribute('type') || '').toLowerCase();
  var submitsForm = form && (
    tag === 'form' ||
    (tag === 'input' && /^(submit|image)$/.test(rootType)) ||
    (tag === 'button' && rootType !== 'button' && rootType !== 'reset')
  );
  if (submitsForm) actions.push('submit');
  var result = {
    tag: tag,
    attributes: attributes,
    descendants: descendants,
    descendantsTruncated: all.length > descendants.length,
    actions: actions
  };
  var role = root.getAttribute('role');
  var name = labelFor(root) || root.getAttribute('name');
  var nearbyText = __comateSensitive(root) ? '' : textWithoutFields(root, MAX_TEXT);
  if (role) result.role = cap(role, 80);
  if (name) result.name = cap(name, 160);
  if (nearbyText) result.nearbyText = nearbyText;
  if (formSummary) result.form = formSummary;
  return result;
}`;
}

/** Build an inspector for a ref-owned XPath/form index; never accepts a caller selector. */
export function buildInspectElementScript(entry: RefEntry): string {
  let target = 'null';
  if (entry.xpath) {
    target = `document.evaluate(${JSON.stringify(entry.xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  } else if (entry.kind === 'form' && typeof entry.formIndex === 'number' && entry.formIndex >= 0) {
    target = `document.forms[${JSON.stringify(entry.formIndex)}]`;
  }
  return `(() => { var inspect = ${buildInspectElementFunction()}; var target = ${target}; return inspect.call(target); })()`;
}

// ---------------------------------------------------------------------------
// In-page extractor script (KTD-3). Runs via Runtime.evaluate, returns the
// raw material for a PageModel: document identity + DOM epoch probe, form
// structure with hashed sensitive values, standalone controls, readability-
// lite main text, and alert signals. Sensitive values are hashed in-page and
// the raw value is never returned.
// ---------------------------------------------------------------------------

export const EXTRACTOR_MAX_CONTENT_CHARS = 4000;

export interface RawExtractedField {
  fieldIndex: number;
  name?: string;
  id?: string;
  label: string;
  tag: string;
  type: string;
  role?: string;
  multiple?: boolean;
  size?: number;
  required: boolean;
  autocomplete?: string;
  disabled: boolean;
  readOnly: boolean;
  sensitive: boolean;
  /** Raw value — only present for non-sensitive fields (capped in-page). */
  value?: string;
  /** True when the field currently holds any value (sensitive-safe bit). */
  filled: boolean;
  submitSemantics: boolean;
  xpath: string;
}

export interface RawExtractedForm {
  formIndex: number;
  name?: string;
  id?: string;
  action?: string;
  method: string;
  fields: RawExtractedField[];
}

export interface RawPageExtraction {
  url: string;
  title: string;
  docId: string;
  domEpoch: number;
  forms: RawExtractedForm[];
  standalone: RawExtractedField[];
  contentText: string;
  contentTruncated: boolean;
  alerts: string[];
  stats: { linkCount: number; buttonCount: number; hasPasswordField: boolean };
}

export function buildExtractorScript(maxContentChars = EXTRACTOR_MAX_CONTENT_CHARS): string {
  return `(() => {
  ${IN_PAGE_SENSITIVE_FN}
  var MAX_CONTENT = ${Math.max(200, Math.floor(maxContentChars))};

  // Document identity + structural-mutation probe (idempotent install).
  // childList + characterData only: attribute noise (animations toggling
  // classes/styles) must not invalidate ref batches.
  if (!window.__comateProbe) {
    var probe = {
      docId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2),
      epoch: 0
    };
    try {
      new MutationObserver(function () { probe.epoch += 1; }).observe(
        document.documentElement,
        { subtree: true, childList: true, characterData: true }
      );
    } catch (e) { /* observer unavailable — epoch stays 0 */ }
    window.__comateProbe = probe;
  }
  var probeOut = window.__comateProbe;

  function visible(el) {
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }
  function textOf(el, cap) {
    var t = '';
    try { t = (el.innerText || el.textContent || '').trim(); } catch (e) { t = (el.textContent || '').trim(); }
    return t.length > cap ? t.slice(0, cap) : t;
  }
  function labelFor(el) {
    var i, t;
    try {
      if (el.labels && el.labels.length) {
        for (i = 0; i < el.labels.length; i++) { t = textOf(el.labels[i], 80); if (t) return t; }
      }
    } catch (e) { /* ignore */ }
    t = el.getAttribute('aria-label'); if (t) return t.trim().slice(0, 80);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\\s+/), out = [];
      for (i = 0; i < parts.length; i++) {
        var ref = document.getElementById(parts[i]);
        if (ref) out.push(textOf(ref, 40));
      }
      t = out.join(' ').trim(); if (t) return t.slice(0, 80);
    }
    t = el.getAttribute('placeholder'); if (t) return t.trim().slice(0, 80);
    t = el.getAttribute('name'); if (t) return t.slice(0, 80);
    return el.id ? el.id.slice(0, 80) : '';
  }
  function getXPath(el) {
    if (el.id) return '//*[@id=' + JSON.stringify(el.id) + ']';
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 12) {
      var tag = el.tagName.toLowerCase();
      var index = 1, sib = el.previousElementSibling;
      while (sib) { if (sib.tagName && sib.tagName.toLowerCase() === tag) index += 1; sib = sib.previousElementSibling; }
      parts.unshift(tag + '[' + index + ']');
      el = el.parentElement;
    }
    return '/' + parts.join('/');
  }
  function fieldType(el, tag) {
    if (tag !== 'input') return tag;
    return (el.getAttribute('type') || 'text').toLowerCase();
  }
  function isSubmitControl(el, tag, type, inForm) {
    if (tag === 'input') return type === 'submit' || type === 'image';
    if (tag === 'button') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      return inForm ? t !== 'button' && t !== 'reset' : t === 'submit';
    }
    return false;
  }
  function readField(el, fieldIndex, inForm) {
    var tag = el.tagName.toLowerCase();
    var type = fieldType(el, tag);
    var sensitive = false;
    try { sensitive = __comateSensitive(el); } catch (e) { sensitive = type === 'password'; }
    var value, filled = false;
    var isCheckable = type === 'checkbox' || type === 'radio';
    try {
      var raw = isCheckable ? String(!!el.checked) : String(el.value == null ? '' : el.value);
      filled = raw.length > 0 && raw !== 'false';
      if (!sensitive) value = raw.length > 80 ? raw.slice(0, 80) : raw;
    } catch (e) { /* value unreadable */ }
    return {
      fieldIndex: fieldIndex,
      name: el.getAttribute('name') || undefined,
      id: el.id || undefined,
      label: labelFor(el),
      tag: tag,
      type: type,
      role: el.getAttribute('role') || undefined,
      multiple: el.multiple === true,
      size: typeof el.size === 'number' ? el.size : undefined,
      required: el.required === true,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      disabled: el.disabled === true,
      readOnly: el.readOnly === true,
      sensitive: sensitive,
      value: value,
      filled: filled,
      submitSemantics: isSubmitControl(el, tag, type, inForm),
      xpath: getXPath(el)
    };
  }

  var MAX_FORMS = 10, MAX_FIELDS = 30, MAX_STANDALONE = 10;
  var forms = [];
  var formEls = Array.prototype.slice.call(document.forms || []);
  var hasPasswordField = false;
  for (var fi = 0; fi < formEls.length && forms.length < MAX_FORMS; fi++) {
    var form = formEls[fi];
    var fields = [];
    var els = Array.prototype.slice.call(form.elements || []);
    for (var ej = 0; ej < els.length && fields.length < MAX_FIELDS; ej++) {
      var el = els[ej], tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (['input', 'select', 'textarea', 'button'].indexOf(tag) === -1) continue;
      var ftype = fieldType(el, tag);
      if (ftype === 'hidden' || ftype === 'fieldset' || ftype === 'object') continue;
      var f = readField(el, ej, true);
      if (f.sensitive && f.type === 'password') hasPasswordField = true;
      fields.push(f);
    }
    var actionAttr = form.getAttribute('action');
    forms.push({
      formIndex: fi,
      name: form.getAttribute('name') || undefined,
      id: form.id || undefined,
      action: actionAttr ? String(form.action || '') : undefined,
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      fields: fields
    });
  }

  var standalone = [];
  var allControls = document.querySelectorAll('input, select, textarea');
  for (var si = 0; si < allControls.length && standalone.length < MAX_STANDALONE; si++) {
    var ctrl = allControls[si];
    if (ctrl.form) continue;
    if (!visible(ctrl)) continue;
    var stag = ctrl.tagName.toLowerCase();
    if (fieldType(ctrl, stag) === 'hidden') continue;
    standalone.push(readField(ctrl, -1, false));
  }

  // Readability-lite: score block candidates by paragraph text density with a
  // link-density penalty; fall back to body text.
  function mainText() {
    var candidates = document.querySelectorAll('article, main, [role="main"], section, div');
    var best = '', bestScore = 0;
    var limit = Math.min(candidates.length, 400);
    for (var i = 0; i < limit; i++) {
      var el = candidates[i];
      var ps = el.querySelectorAll('p');
      if (ps.length === 0) continue;
      var text = '';
      for (var j = 0; j < ps.length; j++) text += textOf(ps[j], 1000) + '\\n';
      text = text.trim();
      if (text.length < 200) continue;
      var linkText = 0, links = el.querySelectorAll('a');
      for (var k = 0; k < links.length; k++) linkText += textOf(links[k], 1000).length;
      var score = text.length * (1 - Math.min(0.9, linkText / Math.max(1, text.length)));
      if (score > bestScore) { bestScore = score; best = text; }
    }
    if (!best && document.body) best = textOf(document.body, MAX_CONTENT * 2);
    return best;
  }

  var contentText = mainText();
  var contentTruncated = contentText.length > MAX_CONTENT;
  if (contentTruncated) contentText = contentText.slice(0, MAX_CONTENT);

  var alerts = [];
  var alertEls = document.querySelectorAll('[role="alert"], [aria-live="assertive"], .alert, .error');
  for (var ai = 0; ai < alertEls.length && alerts.length < 5; ai++) {
    if (!visible(alertEls[ai])) continue;
    var at = textOf(alertEls[ai], 200);
    if (at) alerts.push(at);
  }
  var captchaProbe = '';
  try {
    var frames = document.querySelectorAll('iframe[src]');
    for (var ci = 0; ci < frames.length; ci++) captchaProbe += ' ' + frames[ci].getAttribute('src');
    captchaProbe += ' ' + (document.body ? document.body.className : '');
  } catch (e) { /* ignore */ }
  if (/captcha|recaptcha|hcaptcha|turnstile/i.test(captchaProbe)) {
    alerts.push('Possible CAPTCHA challenge detected on this page.');
  }

  return {
    url: String(location.href),
    title: String(document.title || ''),
    docId: probeOut.docId,
    domEpoch: probeOut.epoch,
    forms: forms,
    standalone: standalone,
    contentText: contentText,
    contentTruncated: contentTruncated,
    alerts: alerts,
    stats: {
      linkCount: document.querySelectorAll('a[href]').length,
      buttonCount: document.querySelectorAll('button, input[type="submit"], [role="button"]').length,
      hasPasswordField: hasPasswordField
    }
  };
})()`;
}

// ---------------------------------------------------------------------------
// Accessibility tree processing (KTD-3: a11y tree is the action spine).
// ---------------------------------------------------------------------------

export interface RawAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
}

/** Widget roles that become top-level actions (form controls live in forms). */
export const ACTION_ROLES: readonly string[] = [
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'switch',
];

export const MAX_ACTIONS = 40;
const MAX_ACTION_NAME = 80;

export interface ExtractedAction {
  role: string;
  name: string;
  backendNodeId: number;
}

export function extractActionsFromAxTree(
  nodes: RawAxNode[],
  maxActions = MAX_ACTIONS,
): ExtractedAction[] {
  const actionRoles = new Set(ACTION_ROLES);
  const seenBackendIds = new Set<number>();
  const actions: ExtractedAction[] = [];
  for (const node of nodes) {
    if (actions.length >= maxActions) break;
    if (node.ignored) continue;
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    if (!actionRoles.has(role)) continue;
    const backendNodeId = node.backendDOMNodeId;
    if (typeof backendNodeId !== 'number' || seenBackendIds.has(backendNodeId)) continue;
    seenBackendIds.add(backendNodeId);
    const rawName = typeof node.name?.value === 'string' ? node.name.value.trim() : '';
    actions.push({
      role,
      name: rawName.length > MAX_ACTION_NAME ? rawName.slice(0, MAX_ACTION_NAME) : rawName,
      backendNodeId,
    });
  }
  return actions;
}

/** Alert-role AX nodes complement the in-page alert heuristics. */
export function extractAlertsFromAxTree(nodes: RawAxNode[], maxAlerts = 5): string[] {
  const alerts: string[] = [];
  for (const node of nodes) {
    if (alerts.length >= maxAlerts) break;
    if (node.ignored) continue;
    if (node.role?.value !== 'alert') continue;
    const text = typeof node.name?.value === 'string' ? node.name.value.trim() : '';
    if (text) alerts.push(text.slice(0, 200));
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Distillation
// ---------------------------------------------------------------------------

/** CDP surface the distiller needs (real: browser-cdp; tests: fake). */
export interface PageModelSource {
  evaluate<T>(expression: string): Promise<T>;
  getFullAXTree(): Promise<RawAxNode[]>;
}

const VALUE_CAP = 80;

function classifyPageType(extraction: RawPageExtraction, formCount: number): PageType {
  if (extraction.stats.hasPasswordField) return 'login';
  if (formCount > 0) return 'form';
  if (extraction.contentText.length > 1500 && extraction.stats.linkCount < 30) return 'article';
  if (extraction.stats.linkCount > 50) return 'listing';
  return 'unknown';
}

/**
 * Mint a field ref and build its model field. Shared by the in-form and
 * standalone-control paths; `placement` carries what differs between them
 * (real form/field indices + extractor submit semantics, or the synthetic
 * -1/-1 + false for standalone page controls).
 */
function mapRawField(
  refTable: RefTable,
  rawField: RawExtractedField,
  placement: { formIndex: number; fieldIndex: number; submitSemantics: boolean },
): PageModelField {
  const role = normalizedFieldRole(rawField);
  const entry = refTable.mint({
    kind: 'field',
    role,
    name: rawField.label || rawField.name || '',
    xpath: rawField.xpath,
    formIndex: placement.formIndex,
    fieldIndex: placement.fieldIndex,
    submitSemantics: placement.submitSemantics,
  });
  const modelField: PageModelField = {
    ref: entry.ref,
    label: rawField.label,
    tag: rawField.tag,
    type: rawField.type,
    role,
    required: rawField.required,
    sensitive: rawField.sensitive,
    submitSemantics: placement.submitSemantics,
  };
  if (rawField.name !== undefined) modelField.name = rawField.name;
  if (rawField.autocomplete !== undefined) modelField.autocomplete = rawField.autocomplete;
  // Sensitive values never reach the model — the extractor already hashed
  // and dropped them, and we defensively re-check sidecar-side.
  if (rawField.value !== undefined && !rawField.sensitive && !isSensitiveField(rawField)) {
    modelField.value = rawField.value.slice(0, VALUE_CAP);
  }
  return modelField;
}

function normalizedFieldRole(
  field: Pick<RawExtractedField, 'tag' | 'type' | 'role' | 'multiple' | 'size'>,
): string {
  if (field.role) return field.role.toLowerCase();
  const tag = field.tag.toLowerCase();
  const type = field.type.toLowerCase();
  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button';
  if (tag === 'select') return field.multiple || (field.size ?? 0) > 1 ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return type;
  if (tag === 'input' && type === 'number') return 'spinbutton';
  if (tag === 'input' && type === 'range') return 'slider';
  if (tag === 'input' && type === 'search') return 'searchbox';
  return tag === 'input' ? 'textbox' : tag;
}

/**
 * Distill a live page into a PageModel and mint the new ref batch. Merging:
 * forms/fields come from the in-page extractor (labels, autocomplete,
 * required, sensitivity, XPath refs); actions come from the CDP
 * accessibility tree (authoritative role + name, backendNodeId refs).
 */
export async function distillPageModel(
  source: PageModelSource,
  refTable: RefTable,
  options: { maxContentChars?: number } = {},
): Promise<PageModel> {
  const [extraction, axNodes] = await Promise.all([
    source.evaluate<RawPageExtraction>(buildExtractorScript(options.maxContentChars)),
    source.getFullAXTree(),
  ]);

  refTable.beginBatch({ docId: extraction.docId, domEpoch: extraction.domEpoch });

  const forms: PageModelForm[] = extraction.forms.map((rawForm) => {
    const fields: PageModelField[] = rawForm.fields.map((rawField) =>
      mapRawField(refTable, rawField, {
        formIndex: rawForm.formIndex,
        fieldIndex: rawField.fieldIndex,
        submitSemantics: rawField.submitSemantics,
      }),
    );
    const formEntry = refTable.mint({
      kind: 'form',
      role: 'form',
      name: rawForm.name ?? rawForm.id ?? `form ${rawForm.formIndex}`,
      formIndex: rawForm.formIndex,
    });
    const modelForm: PageModelForm = {
      ref: formEntry.ref,
      formIndex: rawForm.formIndex,
      method: rawForm.method,
      fields,
    };
    if (rawForm.name !== undefined) modelForm.name = rawForm.name;
    if (rawForm.action !== undefined) modelForm.action = rawForm.action;
    return modelForm;
  });

  // Standalone controls (outside any <form>) ride along as a synthetic form
  // entry so fill/select/check refs work for them too.
  if (extraction.standalone.length > 0) {
    const fields: PageModelField[] = extraction.standalone.map((rawField) =>
      mapRawField(refTable, rawField, { formIndex: -1, fieldIndex: -1, submitSemantics: false }),
    );
    const entry = refTable.mint({
      kind: 'form',
      role: 'form',
      name: '(page controls)',
      formIndex: -1,
    });
    forms.push({ ref: entry.ref, formIndex: -1, method: 'get', fields });
  }

  const actions: PageModelAction[] = extractActionsFromAxTree(axNodes).map((action) => {
    const entry = refTable.mint({
      kind: 'action',
      role: action.role,
      name: action.name,
      backendNodeId: action.backendNodeId,
    });
    return { ref: entry.ref, role: action.role, name: action.name, backendNodeId: action.backendNodeId };
  });

  const axAlerts = extractAlertsFromAxTree(axNodes);
  const alerts = [...extraction.alerts];
  for (const alert of axAlerts) {
    if (alerts.length >= 5) break;
    if (!alerts.includes(alert)) alerts.push(alert);
  }

  const model: PageModel = {
    url: extraction.url,
    title: extraction.title,
    pageType: classifyPageType(extraction, extraction.forms.length),
    forms,
    actions,
    content: { text: extraction.contentText, truncated: extraction.contentTruncated },
    alerts,
    tokenEstimate: 0,
  };
  model.tokenEstimate = estimateTokens(model);
  return model;
}

/** Rough token estimate (chars / 4) over the serialized model. */
export function estimateTokens(model: PageModel): number {
  const chars =
    model.url.length +
    model.title.length +
    model.content.text.length +
    model.alerts.reduce((sum, alert) => sum + alert.length, 0) +
    model.actions.reduce((sum, action) => sum + action.name.length + action.role.length + 8, 0) +
    model.forms.reduce(
      (sum, form) =>
        sum +
        (form.action?.length ?? 0) +
        form.fields.reduce(
          (fieldSum, field) =>
            fieldSum + field.label.length + field.type.length + (field.value?.length ?? 0) + 16,
          0,
        ),
      0,
    );
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Page-model delta (act/submit results — "incremental model" per KTD-3).
// ---------------------------------------------------------------------------

export interface PageModelDelta {
  urlChanged: boolean;
  titleChanged: boolean;
  formsAdded: number;
  formsRemoved: number;
  fieldsChanged: number;
  contentChanged: boolean;
  alertsAdded: string[];
  pageChanged: boolean;
}

export function diffPageModels(prev: PageModel | null, next: PageModel): PageModelDelta {
  if (!prev) {
    return {
      urlChanged: true,
      titleChanged: true,
      formsAdded: next.forms.length,
      formsRemoved: 0,
      fieldsChanged: 0,
      contentChanged: true,
      alertsAdded: next.alerts,
      pageChanged: true,
    };
  }
  const prevFormKeys = prev.forms.map((form) => `${form.formIndex}:${form.name ?? ''}:${form.fields.length}`);
  const nextFormKeys = next.forms.map((form) => `${form.formIndex}:${form.name ?? ''}:${form.fields.length}`);
  const formsAdded = nextFormKeys.filter((key) => !prevFormKeys.includes(key)).length;
  const formsRemoved = prevFormKeys.filter((key) => !nextFormKeys.includes(key)).length;
  let fieldsChanged = 0;
  for (const nextForm of next.forms) {
    const prevForm = prev.forms.find((form) => form.formIndex === nextForm.formIndex);
    if (!prevForm) continue;
    const prevValues = prevForm.fields.map((field) => `${field.name ?? field.label}=${field.value ?? ''}`);
    const nextValues = nextForm.fields.map((field) => `${field.name ?? field.label}=${field.value ?? ''}`);
    fieldsChanged += nextValues.filter((value, index) => prevValues[index] !== value).length;
  }
  const alertsAdded = next.alerts.filter((alert) => !prev.alerts.includes(alert));
  const urlChanged = prev.url !== next.url;
  const titleChanged = prev.title !== next.title;
  const contentChanged = prev.content.text !== next.content.text;
  return {
    urlChanged,
    titleChanged,
    formsAdded,
    formsRemoved,
    fieldsChanged,
    contentChanged,
    alertsAdded,
    pageChanged: urlChanged || titleChanged || formsAdded > 0 || formsRemoved > 0 || contentChanged,
  };
}

// ---------------------------------------------------------------------------
// Submit confirmation payload + TOCTOU snapshot diff (KTD-4 ②).
// ---------------------------------------------------------------------------

/** Raw form state read in-page; sensitive values are hashes, never values. */
export interface SubmitSnapshot {
  action: string;
  method: string;
  fields: Array<{
    name: string;
    type: string;
    sensitive: boolean;
    /** Non-sensitive: capped raw value. Sensitive: `h:<hash>:<len>`. */
    value: string;
  }>;
}

export function buildSubmitSnapshotScript(formIndex: number): string {
  return `(() => {
  ${IN_PAGE_SENSITIVE_FN}
  var form = document.forms[${JSON.stringify(formIndex)}];
  if (!form) return null;
  function hash(v) {
    var h = 0, s = String(v == null ? '' : v);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 'h:' + (h >>> 0).toString(16) + ':' + s.length;
  }
  var fields = [];
  var els = Array.prototype.slice.call(form.elements || []);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (['input', 'select', 'textarea'].indexOf(tag) === -1) continue;
    if (!el.name || el.disabled) continue;
    var type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    var sensitive = false;
    try { sensitive = __comateSensitive(el); } catch (e) { sensitive = type === 'password'; }
    var raw = (type === 'checkbox' || type === 'radio') ? String(!!el.checked) : String(el.value == null ? '' : el.value);
    fields.push({
      name: String(el.name),
      type: type,
      sensitive: sensitive,
      value: sensitive ? hash(raw) : (raw.length > 200 ? raw.slice(0, 200) : raw)
    });
  }
  return {
    action: String(form.action || ''),
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: fields
  };
})()`;
}

/**
 * Confirmation-card payload (KTD-4 ②): the ONLY form state allowed into the
 * pending_approval event stream. Sensitive fields are listed by name/label —
 * values are absent by construction (KTD-8).
 */
export function sanitizeSubmitPayload(input: {
  url: string;
  formName?: string;
  snapshot: SubmitSnapshot;
}): Record<string, unknown> {
  const origin = originOf(input.snapshot.action || input.url) ?? '(unparseable)';
  return {
    kind: 'browser_submit',
    pageUrl: input.url,
    formName: input.formName,
    action: input.snapshot.action,
    actionOrigin: origin,
    method: input.snapshot.method.toUpperCase(),
    fields: input.snapshot.fields.map((field) => {
      const entry: Record<string, unknown> = {
        name: field.name,
        type: field.type,
        sensitive: field.sensitive,
      };
      if (!field.sensitive) {
        entry.value = field.value.length > 80 ? `${field.value.slice(0, 80)}…` : field.value;
      }
      return entry;
    }),
  };
}

export interface SubmitSnapshotDiff {
  field?: string;
  kind: 'action_changed' | 'method_changed' | 'value_changed' | 'field_added' | 'field_removed';
}

/** Field names + change kinds only — never values (safe for re-confirm cards). */
export function diffSubmitSnapshots(approved: SubmitSnapshot, current: SubmitSnapshot): SubmitSnapshotDiff[] {
  const diffs: SubmitSnapshotDiff[] = [];
  if (approved.action !== current.action) {
    diffs.push({ kind: 'action_changed' });
  }
  if (approved.method !== current.method) {
    diffs.push({ kind: 'method_changed' });
  }
  const approvedByName = new Map(approved.fields.map((field) => [field.name, field]));
  const currentByName = new Map(current.fields.map((field) => [field.name, field]));
  for (const [name, approvedField] of approvedByName) {
    const currentField = currentByName.get(name);
    if (!currentField) {
      diffs.push({ kind: 'field_removed', field: name });
    } else if (approvedField.value !== currentField.value) {
      diffs.push({ kind: 'value_changed', field: name });
    }
  }
  for (const name of currentByName.keys()) {
    if (!approvedByName.has(name)) {
      diffs.push({ kind: 'field_added', field: name });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// DOM probe read (ref-batch validity check before act/submit dispatch).
// ---------------------------------------------------------------------------

export const READ_PROBE_SCRIPT = `(() => {
  var p = window.__comateProbe;
  if (!p) return null;
  return { docId: p.docId, domEpoch: p.epoch };
})()`;
