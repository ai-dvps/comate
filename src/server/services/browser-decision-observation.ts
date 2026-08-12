import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { sha256Hex } from '../utils/sha256.js';
import type { BrowserCdpSession } from './browser-cdp.js';
import {
  RefTable,
  distillPageModel,
  sameBrowserDocumentIdentity,
  type BrowserDocumentIdentity,
  type PageModel,
  type RefObservationBinding,
} from './browser-page-model.js';

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SensitiveRect extends CssRect {
  source: 'built-in' | 'application';
}

export interface DecisionObservationProbe {
  docId: string;
  domEpoch: number;
  checksum: string;
  captureCss: CssRect;
  layoutViewport: CssRect;
  visualViewport: CssRect;
  pageScaleFactor: number;
  devicePixelRatio: number;
  sensitiveRects: SensitiveRect[];
  nonGroundingRects: CssRect[];
}

export interface DecisionObservationTransform {
  captureCss: CssRect;
  layoutViewport: CssRect;
  visualViewport: CssRect;
  pageScaleFactor: number;
  devicePixelRatio: number;
  nativeImage: { width: number; height: number };
  normalizedImage: { width: number; height: number };
  cssToNativeScaleX: number;
  cssToNativeScaleY: number;
  cssToNormalizedScaleX: number;
  cssToNormalizedScaleY: number;
}

export interface DecisionObservationElementEvidence extends RefObservationBinding {
  ref: string;
  role: string;
  kind: string;
}

export interface BrowserDecisionObservation {
  observationId: string;
  model: PageModel;
  revision: {
    documentIdentity: BrowserDocumentIdentity;
    docId: string;
    domEpoch: number;
    checksum: string;
    controlEpoch: string;
    capabilityEpoch: string;
  };
  elements: DecisionObservationElementEvidence[];
  transform: DecisionObservationTransform;
  image: { data: string; mimeType: 'image/png'; width: number; height: number };
  sensitiveMaskCount: number;
  nonGroundingRects: CssRect[];
}

export type BrowserDecisionObservationErrorCode =
  | 'observation_cancelled'
  | 'observation_unavailable'
  | 'observation_unstable'
  | 'observation_timeout'
  | 'observation_invalid_image'
  | 'observation_too_large'
  | 'observation_invalid_transform'
  | 'observation_mask_failed'
  | 'observation_budget_exhausted';

export class BrowserDecisionObservationError extends Error {
  constructor(readonly code: BrowserDecisionObservationErrorCode, message: string) {
    super(message);
    this.name = 'BrowserDecisionObservationError';
  }
}

export interface DecisionObservationLimits {
  normalizedLongEdge: number;
  maxDecodedPixels: number;
  maxEncodedBytes: number;
  captureDeadlineMs: number;
  maxConcurrentCaptures: number;
  coherenceRetries: number;
  maxObservationsPerTask: number;
}

export const DEFAULT_DECISION_OBSERVATION_LIMITS: Readonly<DecisionObservationLimits> = Object.freeze({
  normalizedLongEdge: 1800,
  maxDecodedPixels: 16_000_000,
  maxEncodedBytes: 4 * 1024 * 1024,
  captureDeadlineMs: 5_000,
  maxConcurrentCaptures: 1,
  coherenceRetries: 1,
  maxObservationsPerTask: 100,
});

export const HARD_DECISION_OBSERVATION_LIMITS: Readonly<DecisionObservationLimits> = Object.freeze({
  normalizedLongEdge: 2000,
  maxDecodedPixels: 32_000_000,
  maxEncodedBytes: 8 * 1024 * 1024,
  captureDeadlineMs: 10_000,
  maxConcurrentCaptures: 1,
  coherenceRetries: 1,
  maxObservationsPerTask: 200,
});

export function validateDecisionObservationLimits(
  overrides: Partial<DecisionObservationLimits> = {},
): DecisionObservationLimits {
  const limits = { ...DEFAULT_DECISION_OBSERVATION_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as Array<keyof DecisionObservationLimits>) {
    const value = limits[key];
    const hard = HARD_DECISION_OBSERVATION_LIMITS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > hard) {
      throw new Error(`Invalid decision observation limit ${key}=${value}; allowed range is 1..${hard}`);
    }
  }
  return Object.freeze(limits);
}

export interface DecisionObservationBudget {
  /** U3 supplies task identity and persistence. U1 only defines the fail-closed seam. */
  consume(): boolean | Promise<boolean>;
}

export interface ApplicationSensitiveRegionProvider {
  /** Application-owned classifications are trusted input, never page/model instructions. */
  regions(model: PageModel, probe: DecisionObservationProbe): SensitiveRect[] | Promise<SensitiveRect[]>;
}

export interface DecisionObservationRequest {
  page: BrowserCdpSession;
  refTable: RefTable;
  signal: AbortSignal;
  isCurrent: () => boolean | Promise<boolean>;
  isAgentInControl?: () => boolean;
  controlEpoch?: string;
  capabilityEpoch?: string;
  budget?: DecisionObservationBudget;
  applicationSensitiveRegions?: ApplicationSensitiveRegionProvider;
}

interface ElementState {
  connected: boolean;
  geometry: CssRect;
  visible: boolean;
  inViewport: boolean;
  occluded: boolean;
  enabled: boolean;
  editable: boolean;
}

const OBSERVATION_PROBE_SCRIPT = `(() => {
  function __comateDecisionObservationProbe() {
    var visual = window.visualViewport;
    var pageLeft = visual ? visual.pageLeft : window.scrollX;
    var pageTop = visual ? visual.pageTop : window.scrollY;
    var visualWidth = visual ? visual.width : window.innerWidth;
    var visualHeight = visual ? visual.height : window.innerHeight;
    var finite = function (value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0; };
    var rectOf = function (el) {
      var rect = el.getBoundingClientRect();
      return { x: finite(rect.left + window.scrollX), y: finite(rect.top + window.scrollY), width: finite(rect.width), height: finite(rect.height) };
    };
    var visible = function (el, rect) {
      var style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    var sensitive = function (el) {
      var type = String(el.getAttribute('type') || '').toLowerCase();
      var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
      var identity = [el.getAttribute('name'), el.id, el.getAttribute('aria-label')].filter(Boolean).join(' ');
      return type === 'password' || /^(?:current-password|new-password|one-time-code)$/.test(ac) || /^cc-/.test(ac) ||
        /pass(word|phrase)?|pwd|secret|token|api[-_]?key|cvv|cvc|ccv|card[-_ ]?(?:num(?:ber)?)?|ssn|otp|2fa|auth[-_ ]?code|verification[-_ ]?code/i.test(identity);
    };
    var nodes = Array.prototype.slice.call(document.querySelectorAll('input,textarea,select,button,a,[role],[contenteditable]')).slice(0, 500);
    var shape = [], sensitiveRects = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], rect = rectOf(el), isVisible = visible(el, rect);
      var cx = Math.max(0, Math.min(window.innerWidth - 1, rect.x - window.scrollX + rect.width / 2));
      var cy = Math.max(0, Math.min(window.innerHeight - 1, rect.y - window.scrollY + rect.height / 2));
      var hit = isVisible && rect.width > 0 && rect.height > 0 ? document.elementFromPoint(cx, cy) : null;
      var occluded = !!hit && hit !== el && !el.contains(hit);
      shape.push([
        el.tagName.toLowerCase(), String(el.getAttribute('type') || '').toLowerCase(),
        String(el.getAttribute('role') || '').toLowerCase(), !!el.disabled,
        String(el.getAttribute('aria-disabled') || '').toLowerCase(), String(el.getAttribute('aria-selected') || '').toLowerCase(),
        String(el.getAttribute('aria-checked') || '').toLowerCase(), !!el.checked,
        isVisible, occluded, rect.x, rect.y, rect.width, rect.height
      ]);
      if (sensitive(el) && isVisible) sensitiveRects.push(Object.assign(rect, { source: 'built-in' }));
    }
    var risky = Array.prototype.slice.call(document.querySelectorAll('canvas,video,img')).slice(0, 100);
    var nonGroundingRects = [];
    for (var j = 0; j < risky.length; j++) {
      var riskyEl = risky[j], riskyStyle = window.getComputedStyle(riskyEl);
      var pseudoBefore = window.getComputedStyle(riskyEl, '::before').content;
      var pseudoAfter = window.getComputedStyle(riskyEl, '::after').content;
      var pendingImage = riskyEl.tagName.toLowerCase() === 'img' && !riskyEl.complete;
      if (pendingImage || riskyEl.tagName.toLowerCase() !== 'img' || riskyStyle.animationName !== 'none' ||
          (pseudoBefore && pseudoBefore !== 'none') || (pseudoAfter && pseudoAfter !== 'none')) nonGroundingRects.push(rectOf(riskyEl));
    }
    var probe = window.__comateProbe || { docId: '', epoch: -1 };
    return {
      docId: String(probe.docId || ''), domEpoch: Number(probe.epoch), checksum: JSON.stringify(shape),
      captureCss: { x: finite(pageLeft), y: finite(pageTop), width: finite(visualWidth), height: finite(visualHeight) },
      layoutViewport: { x: finite(window.scrollX), y: finite(window.scrollY), width: finite(window.innerWidth), height: finite(window.innerHeight) },
      visualViewport: { x: finite(visual ? visual.offsetLeft : 0), y: finite(visual ? visual.offsetTop : 0), width: finite(visualWidth), height: finite(visualHeight) },
      pageScaleFactor: finite(visual ? visual.scale : 1), devicePixelRatio: finite(window.devicePixelRatio),
      sensitiveRects: sensitiveRects, nonGroundingRects: nonGroundingRects
    };
  }
  return __comateDecisionObservationProbe();
})()`;

const REF_STATE_FUNCTION = `function __comateDecisionObservationRefState() {
  var el = this;
  if (!el || !el.isConnected || !el.getBoundingClientRect) return null;
  var rect = el.getBoundingClientRect(), style = window.getComputedStyle(el);
  var finite = function (value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0; };
  var visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  var inViewport = visible && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  var hit = inViewport ? document.elementFromPoint(Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))) : null;
  var role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
  var tag = String(el.tagName || '').toLowerCase();
  return {
    connected: true,
    geometry: { x: finite(rect.left + window.scrollX), y: finite(rect.top + window.scrollY), width: finite(rect.width), height: finite(rect.height) },
    visible: visible, inViewport: inViewport, occluded: !!hit && hit !== el && !el.contains(hit),
    enabled: !el.disabled && String(el.getAttribute && el.getAttribute('aria-disabled') || '').toLowerCase() !== 'true',
    editable: !!el.isContentEditable || tag === 'textarea' || tag === 'select' || tag === 'input' || role === 'textbox' || role === 'searchbox' || role === 'combobox'
  };
}`;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validRect(rect: CssRect, allowZeroOrigin = true): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
    (allowZeroOrigin || (rect.x >= 0 && rect.y >= 0)) && finitePositive(rect.width) && finitePositive(rect.height);
}

function sameProbe(left: DecisionObservationProbe, right: DecisionObservationProbe): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProbe(probe: DecisionObservationProbe): void {
  if (!probe || typeof probe.docId !== 'string' || !Number.isSafeInteger(probe.domEpoch) ||
      typeof probe.checksum !== 'string' || !validRect(probe.captureCss) ||
      !validRect(probe.layoutViewport) || !validRect(probe.visualViewport) ||
      !finitePositive(probe.devicePixelRatio) || !finitePositive(probe.pageScaleFactor) ||
      probe.devicePixelRatio > 16 || probe.pageScaleFactor > 16 ||
      !Array.isArray(probe.sensitiveRects) || !Array.isArray(probe.nonGroundingRects)) {
    throw new BrowserDecisionObservationError('observation_invalid_transform', 'Browser viewport metrics are invalid');
  }
}

function assertCurrent(
  request: DecisionObservationRequest,
  localSignal: AbortSignal,
): Promise<void> | void {
  if (request.signal.aborted || localSignal.aborted || request.page.closed || request.isAgentInControl?.() === false) {
    throw new BrowserDecisionObservationError('observation_cancelled', 'Decision observation was cancelled');
  }
  return Promise.resolve(request.isCurrent()).then((current) => {
    if (!current || request.signal.aborted || localSignal.aborted || request.page.closed || request.isAgentInControl?.() === false) {
      throw new BrowserDecisionObservationError('observation_cancelled', 'Decision observation was cancelled');
    }
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signals: AbortSignal[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new BrowserDecisionObservationError('observation_cancelled', 'Decision observation was cancelled')));
    const timer = setTimeout(() => finish(() => reject(new BrowserDecisionObservationError('observation_timeout', 'Screenshot capture exceeded its deadline'))), timeoutMs);
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

function decodePng(base64: string, limits: DecisionObservationLimits): PNG {
  const encoded = Buffer.from(base64, 'base64');
  if (encoded.length === 0) throw new BrowserDecisionObservationError('observation_invalid_image', 'Screenshot is empty');
  if (encoded.length > limits.maxEncodedBytes) throw new BrowserDecisionObservationError('observation_too_large', 'Encoded screenshot exceeds the configured limit');
  let image: PNG;
  try {
    image = PNG.sync.read(encoded, { checkCRC: true });
  } catch {
    throw new BrowserDecisionObservationError('observation_invalid_image', 'Screenshot is not a valid PNG image');
  }
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width <= 0 || image.height <= 0 || image.width * image.height > limits.maxDecodedPixels) {
    throw new BrowserDecisionObservationError('observation_too_large', 'Decoded screenshot dimensions exceed the configured limit');
  }
  return image;
}

function maskRegions(image: PNG, rects: SensitiveRect[], probe: DecisionObservationProbe): number {
  let count = 0;
  const scaleX = image.width / probe.captureCss.width;
  const scaleY = image.height / probe.captureCss.height;
  for (const rect of rects) {
    if (!validRect(rect)) throw new BrowserDecisionObservationError('observation_mask_failed', 'Sensitive rectangle is invalid');
    const x0 = Math.max(0, Math.floor((rect.x - probe.captureCss.x) * scaleX));
    const y0 = Math.max(0, Math.floor((rect.y - probe.captureCss.y) * scaleY));
    const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width - probe.captureCss.x) * scaleX));
    const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height - probe.captureCss.y) * scaleY));
    if (x1 <= x0 || y1 <= y0) continue;
    count += 1;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = 0;
        image.data[offset + 1] = 0;
        image.data[offset + 2] = 0;
        image.data[offset + 3] = 255;
      }
    }
  }
  return count;
}

function normalize(image: PNG, longEdge: number): PNG {
  const sourceLongEdge = Math.max(image.width, image.height);
  if (sourceLongEdge <= longEdge) return image;
  const ratio = longEdge / sourceLongEdge;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / ratio));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / ratio));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const outputOffset = (y * width + x) * 4;
      image.data.copy(output.data, outputOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return output;
}

function buildTransform(probe: DecisionObservationProbe, native: PNG, normalized: PNG): DecisionObservationTransform {
  const nativeScaleX = native.width / probe.captureCss.width;
  const nativeScaleY = native.height / probe.captureCss.height;
  const normalizedScaleX = normalized.width / probe.captureCss.width;
  const normalizedScaleY = normalized.height / probe.captureCss.height;
  const aspectDrift = Math.abs(nativeScaleX - nativeScaleY) / Math.max(nativeScaleX, nativeScaleY);
  if (![nativeScaleX, nativeScaleY, normalizedScaleX, normalizedScaleY].every(finitePositive) || aspectDrift > 0.02) {
    throw new BrowserDecisionObservationError('observation_invalid_transform', 'Screenshot dimensions do not represent the captured CSS viewport');
  }
  return {
    captureCss: probe.captureCss,
    layoutViewport: probe.layoutViewport,
    visualViewport: probe.visualViewport,
    pageScaleFactor: probe.pageScaleFactor,
    devicePixelRatio: probe.devicePixelRatio,
    nativeImage: { width: native.width, height: native.height },
    normalizedImage: { width: normalized.width, height: normalized.height },
    cssToNativeScaleX: nativeScaleX,
    cssToNativeScaleY: nativeScaleY,
    cssToNormalizedScaleX: normalizedScaleX,
    cssToNormalizedScaleY: normalizedScaleY,
  };
}

export class DecisionObservationCoordinator {
  readonly limits: DecisionObservationLimits;
  private active?: AbortController;

  constructor(overrides: Partial<DecisionObservationLimits> = {}) {
    this.limits = validateDecisionObservationLimits(overrides);
  }

  async observe(request: DecisionObservationRequest): Promise<BrowserDecisionObservation> {
    if (request.budget && !await request.budget.consume()) {
      throw new BrowserDecisionObservationError('observation_budget_exhausted', 'Decision observation budget is exhausted');
    }
    this.active?.abort();
    const localAbort = new AbortController();
    this.active = localAbort;
    try {
      for (let attempt = 0; attempt <= this.limits.coherenceRetries; attempt += 1) {
        try {
          return await this.observeOnce(request, localAbort.signal);
        } catch (error) {
          const retryable = error instanceof BrowserDecisionObservationError && error.code === 'observation_unstable';
          if (!retryable || attempt === this.limits.coherenceRetries) throw error;
        }
      }
      throw new BrowserDecisionObservationError('observation_unstable', 'Decision observation remained unstable');
    } finally {
      if (this.active === localAbort) this.active = undefined;
    }
  }

  cancel(): void {
    this.active?.abort();
  }

  private async observeOnce(
    request: DecisionObservationRequest,
    localSignal: AbortSignal,
  ): Promise<BrowserDecisionObservation> {
    await assertCurrent(request, localSignal);
    const beforeIdentity = request.page.getDocumentIdentity?.();
    if (!beforeIdentity) throw new BrowserDecisionObservationError('observation_unavailable', 'Document identity is unavailable');
    const before = await request.page.evaluate<DecisionObservationProbe>(OBSERVATION_PROBE_SCRIPT);
    assertProbe(before);
    await assertCurrent(request, localSignal);

    const model = await distillPageModel(request.page, request.refTable, {
      maxContentChars: 1200,
      maxActions: 1000,
      coherenceRetries: 0,
    });
    if (model.pageRevision !== sha256Hex(`${before.docId}:${before.domEpoch}`).slice(0, 12)) {
      throw new BrowserDecisionObservationError('observation_unstable', 'Page revision changed while distilling the observation');
    }
    if (!request.page.callBackendNode) {
      throw new BrowserDecisionObservationError('observation_unavailable', 'Trusted backend-node inspection is unavailable');
    }
    const entryStates = new Map<string, ElementState>();
    for (const entry of request.refTable.currentEntries()) {
      const state = await request.page.callBackendNode<ElementState>(entry.backendNodeId, REF_STATE_FUNCTION);
      if (!state?.connected || !validRect(state.geometry)) {
        throw new BrowserDecisionObservationError('observation_unstable', `Ref ${entry.ref} changed while collecting geometry`);
      }
      entryStates.set(entry.ref, state);
    }
    await assertCurrent(request, localSignal);
    const screenshot = await withDeadline(
      request.page.captureScreenshot({ format: 'png' }),
      this.limits.captureDeadlineMs,
      [request.signal, localSignal],
    );
    await assertCurrent(request, localSignal);
    const native = decodePng(screenshot, this.limits);
    const applicationRects = request.applicationSensitiveRegions
      ? await request.applicationSensitiveRegions.regions(model, before)
      : [];
    const sensitiveRects = [...before.sensitiveRects, ...applicationRects.map((rect) => ({ ...rect, source: 'application' as const }))];
    const sensitiveMaskCount = maskRegions(native, sensitiveRects, before);
    const normalized = normalize(native, this.limits.normalizedLongEdge);
    const transform = buildTransform(before, native, normalized);

    const after = await request.page.evaluate<DecisionObservationProbe>(OBSERVATION_PROBE_SCRIPT);
    assertProbe(after);
    const afterIdentity = request.page.getDocumentIdentity?.();
    await assertCurrent(request, localSignal);
    if (!afterIdentity || !sameBrowserDocumentIdentity(beforeIdentity, afterIdentity) || !sameProbe(before, after)) {
      throw new BrowserDecisionObservationError('observation_unstable', 'Page changed during screenshot capture');
    }

    const observationId = randomUUID();
    const controlEpoch = request.controlEpoch ?? 'unscoped';
    const capabilityEpoch = request.capabilityEpoch ?? 'unscoped';
    const encoded = PNG.sync.write(normalized);
    if (encoded.length > this.limits.maxEncodedBytes) {
      throw new BrowserDecisionObservationError('observation_too_large', 'Normalized screenshot exceeds the configured encoded limit');
    }
    const elements = request.refTable.currentEntries().map((entry): DecisionObservationElementEvidence => {
      const state = entryStates.get(entry.ref)!;
      const binding: RefObservationBinding = {
        observationId,
        documentIdentity: beforeIdentity,
        pageRevision: model.pageRevision,
        controlEpoch,
        capabilityEpoch,
        structuralChecksum: before.checksum,
        geometry: state.geometry,
        visible: state.visible,
        inViewport: state.inViewport,
        occluded: state.occluded,
        enabled: state.enabled,
        editable: state.editable,
      };
      request.refTable.bindObservation(entry.ref, binding);
      return { ref: entry.ref, role: entry.role, kind: entry.kind, ...binding };
    });
    return {
      observationId,
      model,
      revision: {
        documentIdentity: beforeIdentity,
        docId: before.docId,
        domEpoch: before.domEpoch,
        checksum: before.checksum,
        controlEpoch,
        capabilityEpoch,
      },
      elements,
      transform,
      image: { data: encoded.toString('base64'), mimeType: 'image/png', width: normalized.width, height: normalized.height },
      sensitiveMaskCount,
      nonGroundingRects: before.nonGroundingRects,
    };
  }
}
