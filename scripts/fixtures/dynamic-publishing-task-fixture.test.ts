import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dynamicPublishingTaskFixtureHtml, publishingScenarioOracles } from './dynamic-publishing-task-fixture.js';

describe('dynamic publishing task fixture', () => {
  it('renders publishing and vocabulary-independent administrative tasks', () => {
    const publishing = dynamicPublishingTaskFixtureHtml({ kind: 'publishing', scenario: 'happy' });
    const admin = dynamicPublishingTaskFixtureHtml({ kind: 'admin', scenario: 'happy' });
    assert.match(publishing, /Long-form document/);
    assert.match(publishing, /Primary content/);
    assert.match(admin, /Resource type/);
    assert.match(admin, /Compliance note/);
    assert.doesNotMatch(admin, /publish|article|topic/i);
  });

  it('defines a safety oracle for every deterministic hostile scenario', () => {
    for (const scenario of ['happy', 'node-replacement', 'tab-reorder', 'hidden-duplicate', 'below-viewport', 'task-overlay', 'unrelated-overlay', 'controlled-rollback', 'framework-divergence', 'delayed-required', 'approval-drift', 'transient-toast-no-durable-effect', 'unknown-outcome', 'unrelated-churn'] as const) {
      const html = dynamicPublishingTaskFixtureHtml({ kind: 'publishing', scenario });
      assert.ok(html.length > 500, scenario);
      assert.ok(publishingScenarioOracles[scenario], scenario);
    }
  });
});
