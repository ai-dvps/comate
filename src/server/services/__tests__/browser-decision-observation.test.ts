import '../../test-utils/test-env.js';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import {
  BrowserDecisionObservationError,
  DecisionObservationCoordinator,
  validateDecisionObservationLimits,
  type DecisionObservationProbe,
} from '../browser-decision-observation.js';
import type { BrowserCdpSession } from '../browser-cdp.js';
import { RefTable, type RawPageExtraction } from '../browser-page-model.js';

const identity = {
  targetId: 'target', sessionId: 'cdp', frameId: 'main', loaderId: 'loader', generation: 1,
};

function pngBase64(width = 4, height = 2): string {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 220;
    image.data[offset + 1] = 30;
    image.data[offset + 2] = 40;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image).toString('base64');
}

function extraction(): RawPageExtraction {
  return {
    url: 'https://example.test/editor', title: 'Editor', docId: 'doc', domEpoch: 7,
    forms: [],
    standalone: [{
      fieldIndex: 0, name: 'password', id: 'password', label: 'Password', tag: 'input',
      type: 'password', required: true, disabled: false, readOnly: false, sensitive: true,
      filled: true, submitSemantics: false, xpath: '/html/body/input',
    }],
    contentText: '', contentTruncated: false, alerts: [],
    stats: { linkCount: 0, buttonCount: 0, hasPasswordField: true },
  };
}

function probe(checksum = 'stable'): DecisionObservationProbe {
  return {
    docId: 'doc', domEpoch: 7, checksum,
    captureCss: { x: 12, y: 24, width: 2, height: 1 },
    layoutViewport: { x: 10, y: 20, width: 5, height: 4 },
    visualViewport: { x: 2, y: 4, width: 2, height: 1 },
    pageScaleFactor: 1.25, devicePixelRatio: 2,
    sensitiveRects: [{ x: 12, y: 24, width: 1, height: 1, source: 'built-in' }],
    nonGroundingRects: [],
  };
}

class FakeObservationPage implements BrowserCdpSession {
  closed = false;
  captures = 0;
  probes: DecisionObservationProbe[];
  screenshot = pngBase64();
  capturePromise?: Promise<string>;
  constructor(probes: DecisionObservationProbe[] = [probe(), probe()]) { this.probes = [...probes]; }
  getDocumentIdentity() { return { ...identity }; }
  async evaluate<T>(expression: string): Promise<T> {
    assert.match(expression, /__comateDecisionObservationProbe/);
    return (this.probes.length > 1 ? this.probes.shift() : this.probes[0]) as T;
  }
  async extractPageModel() {
    return { extraction: extraction(), backendNodeIds: [100, 101] };
  }
  async getFullAXTree() { return []; }
  async callBackendNode<T>(backendNodeId: number, functionDeclaration: string): Promise<T | null> {
    if (functionDeclaration.includes('__comateDecisionObservationRefState')) {
      return {
        connected: true,
        geometry: backendNodeId === 100
          ? { x: 12, y: 24, width: 2, height: 1 }
          : { x: 12, y: 24, width: 1, height: 1 },
        visible: true, inViewport: true, occluded: false, enabled: true, editable: backendNodeId !== 100,
      } as T;
    }
    return (backendNodeId === 100
      ? { tag: 'body', type: 'body', role: '', editable: false, fileInput: false }
      : { tag: 'input', type: 'password', role: 'textbox', editable: true, fileInput: false }) as T;
  }
  async captureScreenshot(): Promise<string> {
    this.captures += 1;
    return this.capturePromise ?? this.screenshot;
  }
  async navigate(): Promise<void> {}
  async clickBackendNode(): Promise<never> { throw new Error('not used'); }
  async setCookies(): Promise<void> {}
  async evaluateOnNewDocument(): Promise<void> {}
  onClose(): void {}
  close(): void { this.closed = true; }
}

describe('DecisionObservationCoordinator', () => {
  it('returns one coherent mixed observation with a DPR transform and masked pixels', async () => {
    const page = new FakeObservationPage();
    const refTable = new RefTable();
    const result = await new DecisionObservationCoordinator().observe({
      page, refTable, signal: new AbortController().signal,
      isCurrent: () => true,
    });

    assert.equal(result.model.pageRevision.length, 12);
    assert.equal(result.transform.devicePixelRatio, 2);
    assert.deepEqual(result.transform.captureCss, { x: 12, y: 24, width: 2, height: 1 });
    assert.equal(result.transform.cssToNormalizedScaleX, 2);
    assert.equal(result.transform.cssToNormalizedScaleY, 2);
    assert.equal(result.image.mimeType, 'image/png');
    assert.equal(result.image.width, 4);
    assert.equal(result.image.height, 2);
    assert.equal(result.sensitiveMaskCount, 1);
    const fieldRef = result.model.forms[0].fields[0].ref;
    const binding = result.elements.find((element) => element.ref === fieldRef);
    assert.equal(binding?.observationId, result.observationId);
    assert.equal(binding?.pageRevision, result.model.pageRevision);
    assert.equal(refTable.getObservationBinding(fieldRef)?.observationId, result.observationId);
    const decoded = PNG.sync.read(Buffer.from(result.image.data, 'base64'));
    assert.deepEqual([...decoded.data.subarray(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...decoded.data.subarray(8, 12)], [220, 30, 40, 255]);
  });

  it('retries the complete observation once after structural drift', async () => {
    const page = new FakeObservationPage([
      probe('before-1'), probe('after-1'), probe('stable-2'), probe('stable-2'),
    ]);
    const result = await new DecisionObservationCoordinator().observe({
      page, refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
    });
    assert.equal(page.captures, 2);
    assert.equal(result.revision.checksum, 'stable-2');
  });

  it('returns no partial bundle after the second drift', async () => {
    const page = new FakeObservationPage([
      probe('before-1'), probe('after-1'), probe('before-2'), probe('after-2'),
    ]);
    await assert.rejects(
      new DecisionObservationCoordinator().observe({
        page, refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_unstable',
    );
    assert.equal(page.captures, 2);
  });

  it('fails closed on timeout, encoded overflow, cancellation, or stale invocation', async () => {
    const timeoutPage = new FakeObservationPage();
    timeoutPage.capturePromise = new Promise(() => undefined);
    await assert.rejects(
      new DecisionObservationCoordinator({ captureDeadlineMs: 5 }).observe({
        page: timeoutPage, refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_timeout',
    );

    const overflowPage = new FakeObservationPage();
    const overflowRefs = new RefTable();
    await assert.rejects(
      new DecisionObservationCoordinator({ maxEncodedBytes: 8 }).observe({
        page: overflowPage, refTable: overflowRefs, signal: new AbortController().signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_too_large',
    );
    assert.equal(
      overflowRefs.currentEntries().some((entry) => overflowRefs.getObservationBinding(entry.ref) !== undefined),
      false,
      'a failed image encoding must not leave accepted observation bindings',
    );

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      new DecisionObservationCoordinator().observe({
        page: new FakeObservationPage(), refTable: new RefTable(), signal: cancelled.signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_cancelled',
    );
    await assert.rejects(
      new DecisionObservationCoordinator().observe({
        page: new FakeObservationPage(), refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => false,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_cancelled',
    );
  });

  it('rejects geometry drift, invalid transforms, and decoded oversize without returning refs or pixels', async () => {
    const changedGeometry = probe();
    changedGeometry.captureCss = { ...changedGeometry.captureCss, width: 3 };
    await assert.rejects(
      new DecisionObservationCoordinator().observe({
        page: new FakeObservationPage([probe(), changedGeometry, probe(), changedGeometry]),
        refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_unstable',
    );
    await assert.rejects(
      new DecisionObservationCoordinator({ maxDecodedPixels: 1 }).observe({
        page: new FakeObservationPage(), refTable: new RefTable(),
        signal: new AbortController().signal, isCurrent: () => true,
      }),
      (error: unknown) => error instanceof BrowserDecisionObservationError && error.code === 'observation_too_large',
    );
  });

  it('masks application-classified regions and cancels takeover or a superseded invocation', async () => {
    const applicationMasked = await new DecisionObservationCoordinator().observe({
      page: new FakeObservationPage([probe(), probe()]), refTable: new RefTable(),
      signal: new AbortController().signal, isCurrent: () => true,
      applicationSensitiveRegions: {
        regions: () => [{ x: 13, y: 24, width: 1, height: 1, source: 'application' }],
      },
    });
    const decoded = PNG.sync.read(Buffer.from(applicationMasked.image.data, 'base64'));
    assert.deepEqual([...decoded.data.subarray(8, 12)], [0, 0, 0, 255]);

    let agentInControl = true;
    let releaseCapture!: (value: string) => void;
    const takeoverPage = new FakeObservationPage();
    takeoverPage.capturePromise = new Promise((resolve) => { releaseCapture = resolve; });
    const takeover = new DecisionObservationCoordinator().observe({
      page: takeoverPage, refTable: new RefTable(), signal: new AbortController().signal,
      isCurrent: () => true, isAgentInControl: () => agentInControl,
    });
    await new Promise((resolve) => setImmediate(resolve));
    agentInControl = false;
    releaseCapture(pngBase64());
    await assert.rejects(takeover, (error: unknown) =>
      error instanceof BrowserDecisionObservationError && error.code === 'observation_cancelled');

    const coordinator = new DecisionObservationCoordinator();
    const stalePage = new FakeObservationPage();
    stalePage.capturePromise = new Promise(() => undefined);
    const stale = coordinator.observe({
      page: stalePage, refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const current = coordinator.observe({
      page: new FakeObservationPage(), refTable: new RefTable(), signal: new AbortController().signal, isCurrent: () => true,
    });
    await assert.rejects(stale, (error: unknown) =>
      error instanceof BrowserDecisionObservationError && error.code === 'observation_cancelled');
    await current;
  });
});

describe('decision observation limits', () => {
  it('rejects startup overrides above hard maxima or below valid minima', () => {
    assert.throws(() => validateDecisionObservationLimits({ normalizedLongEdge: 2001 }), /normalizedLongEdge/);
    assert.throws(() => validateDecisionObservationLimits({ maxDecodedPixels: 0 }), /maxDecodedPixels/);
    assert.throws(() => validateDecisionObservationLimits({ coherenceRetries: 2 }), /coherenceRetries/);
  });
});
