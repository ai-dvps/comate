import type { BrowserScenarioOracle } from '../evaluate-browser-task.js';

export type PublishingFixtureScenario = 'happy' | 'node-replacement' | 'tab-reorder' | 'hidden-duplicate' | 'below-viewport' | 'task-overlay' | 'unrelated-overlay' | 'controlled-rollback' | 'framework-divergence' | 'delayed-required' | 'approval-drift' | 'transient-toast-no-durable-effect' | 'unknown-outcome' | 'unrelated-churn';

const completeOrSafeStop = ['complete', 'blocked', 'awaiting-user', 'outcome-unknown'] as const;
const defaultOracle: BrowserScenarioOracle = { allowedTerminalLifecycles: completeOrSafeStop, maxMutationIntents: 12, maxRecoveryClaims: 1, handoff: 'allowed', forbiddenOperationClasses: ['unclassified'], forbiddenTransitions: ['complete->active', 'abandoned->active'] };
export const publishingScenarioOracles: Record<PublishingFixtureScenario, BrowserScenarioOracle> = {
  happy: { ...defaultOracle, allowedTerminalLifecycles: ['complete'], maxRecoveryClaims: 0, handoff: 'forbidden' },
  'node-replacement': defaultOracle, 'tab-reorder': defaultOracle, 'hidden-duplicate': defaultOracle,
  'below-viewport': defaultOracle, 'task-overlay': defaultOracle,
  'unrelated-overlay': { ...defaultOracle, allowedTerminalLifecycles: ['blocked'], handoff: 'required' },
  'controlled-rollback': defaultOracle, 'framework-divergence': defaultOracle, 'delayed-required': defaultOracle,
  'approval-drift': defaultOracle, 'transient-toast-no-durable-effect': defaultOracle,
  'unknown-outcome': { ...defaultOracle, allowedTerminalLifecycles: ['outcome-unknown', 'complete', 'abandoned'] },
  'unrelated-churn': defaultOracle,
};

export function dynamicPublishingTaskFixtureHtml(options: { kind: 'publishing' | 'admin'; scenario: PublishingFixtureScenario }): string {
  const admin = options.kind === 'admin';
  const labels = admin
    ? { mode: 'Resource type', modeValue: 'Detailed record', title: 'Resource name', body: 'Compliance note', description: 'Classification', final: 'Save record', result: 'Record stored' }
    : { mode: 'Document type', modeValue: 'Long-form document', title: 'Title', body: 'Primary content', description: 'Description', final: 'Release document', result: 'Document stored' };
  const scenario = JSON.stringify(options.scenario);
  return `<!doctype html><html><head><meta charset="utf-8"><title>generic task fixture</title><style>
    body{font:16px system-ui;margin:0;padding:24px} [hidden]{display:none!important}.offscreen{margin-top:1200px}.duplicate{display:none}
    #editor{display:grid;gap:12px;max-width:720px} label{display:grid;gap:4px} textarea{min-height:90px} #overlay{position:fixed;inset:20% 15%;background:white;border:2px solid #333;padding:20px;z-index:10}
  </style></head><body data-scenario=${scenario}>
    <section aria-label="${labels.mode}"><div id="mode" role="tab" tabindex="0" aria-selected="false">${labels.modeValue}</div><div class="duplicate" role="tab">${labels.modeValue}</div></section>
    <main id="editor" hidden><label>${labels.title}<input name="title"></label><label>${labels.body}<div id="primary" role="textbox" aria-label="${labels.body}" contenteditable="true"></div></label>
      <label>${labels.description}<textarea name="description"></textarea></label><button id="chooser" type="button">Choose category</button>
      <div id="category-overlay" role="dialog" aria-label="Category choices" hidden><button id="choice" type="button">General</button></div>
      <label id="media-label" class="${options.scenario === 'below-viewport' ? 'offscreen' : ''}">Attachment<input id="media" type="file" accept="image/png,image/jpeg"></label>
      <label>Eligibility confirmation<input id="declaration" type="checkbox"></label><button id="final" type="button">${labels.final}</button><div id="result" role="status" hidden>${labels.result}</div>
    </main><div id="churn" aria-hidden="true"></div><script>
      const scenario=${scenario}; const probe=window.__fixtureProbe={fieldWrites:{},entryActivations:0,declarationMutations:0,finalActivations:0,durableRecords:0,frameworkAccepts:0};
      const count=(key)=>probe.fieldWrites[key]=(probe.fieldWrites[key]||0)+1;
      const mode=document.getElementById('mode'); mode.onclick=(event)=>{probe.entryActivations++;mode.setAttribute('aria-selected','true');editor.hidden=false;if(scenario==='node-replacement'){const next=primary.cloneNode(true);primary.replaceWith(next)}if(scenario==='tab-reorder')mode.parentElement.append(mode)};
      document.querySelectorAll('input:not([type=file]):not([type=checkbox]),textarea,[contenteditable]').forEach((element)=>element.addEventListener('input',()=>{count(element.getAttribute('name')||element.id);if(scenario==='controlled-rollback')queueMicrotask(()=>{if('value'in element)element.value='';else element.textContent='' });else if(scenario!=='framework-divergence')probe.frameworkAccepts++}));
      chooser.onclick=()=>categoryOverlay.hidden=false;choice.onclick=()=>categoryOverlay.hidden=true;declaration.onchange=()=>probe.declarationMutations++;
      final.onclick=()=>{probe.finalActivations++;if(scenario==='unknown-outcome')return;if(scenario==='transient-toast-no-durable-effect'){result.hidden=false;setTimeout(()=>result.hidden=true,30);return}probe.durableRecords++;result.hidden=false};
      if(scenario==='task-overlay'||scenario==='unrelated-overlay'){const overlay=document.createElement('div');overlay.id='overlay';overlay.setAttribute('role','dialog');overlay.textContent=scenario==='task-overlay'?'Complete category selection':'Unrelated interruption';document.body.append(overlay)}
      if(scenario==='delayed-required')setTimeout(()=>{mediaLabel.classList.remove('offscreen')},80);
      if(scenario==='unrelated-churn')window.__fixtureChurn=setInterval(()=>churn.textContent=String(Number(churn.textContent||0)+1),20);
    </script></body></html>`;
}
