export function dynamicSpaBrowserFixtureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dynamic spa authoring</title>
    <style>
      #entry { display:inline-block; cursor:pointer; padding:8px; }
      #editor[hidden] { display:none; }
      #media { position:absolute; width:1px; height:1px; opacity:0; }
      #body { height:120px; overflow:auto; border:1px solid #999; }
    </style></head><body>
    <div id="entry" tabindex="0">Open long form</div>
    <main id="editor" hidden>
      <label>Title<textarea name="title"></textarea></label>
      <div id="body" role="textbox" aria-label="Primary content" contenteditable="true"></div>
      <label id="media-label" for="media">Add media</label>
      <input id="media" type="file" accept="image/png,image/jpeg" multiple>
      <button id="publish" type="button">Release document</button>
    </main>
    <div id="churn" aria-hidden="true"></div>
    <script>
      window.fixtureState = { entryClicks: 0, publishClicks: 0, publishTrusted: false, fileChanges: 0, fileInputs: 0 };
      const entry = document.getElementById('entry');
      entry.addEventListener('click', (event) => {
        window.fixtureState.entryClicks += 1;
        window.fixtureState.entryTrusted = event.isTrusted;
        document.getElementById('editor').hidden = false;
      });
      entry.addEventListener('keydown', (event) => { if (event.key === 'Enter') entry.click(); });
      const media = document.getElementById('media');
      media.addEventListener('input', () => { window.fixtureState.fileInputs += 1; });
      media.addEventListener('change', () => { window.fixtureState.fileChanges += 1; });
      document.getElementById('publish').addEventListener('click', (event) => {
        window.fixtureState.publishClicks += 1;
        window.fixtureState.publishTrusted = event.isTrusted;
      });
      let tick = 0;
      window.fixtureChurn = setInterval(() => { document.getElementById('churn').textContent = String(++tick); }, 20);
    </script></body></html>`;
}
