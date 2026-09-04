import '../src/server/test-utils/test-env.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve('dist/skills-cli/bundle.cjs');
it('pinned CLI installs selected complete Skills across agents and deletes only the selected symlink', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'comate-cli-skills-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const source = path.join(workspace, 'source');
  mkdirSync(home); mkdirSync(workspace);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: '', DISABLE_TELEMETRY: '1', COMATE_SKILL_ISOLATED: '0' };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 30000 });
  try {
    for (const name of ['chosen', 'unselected']) {
      const directory = path.join(source, 'skills', name); mkdirSync(path.join(directory, 'references'), { recursive: true });
      writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Example\n---\nRead references/detail.md`);
      writeFileSync(path.join(directory, 'references/detail.md'), 'Preserve this resource');
    }
    writeFileSync(path.join(workspace, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { legacy: { source: 'old/repo', computedHash: 'old', sourceType: 'git', extra: 'keep' } } }));
    const result = run(['add', source, '--project', '--skill', 'chosen', '--agent', 'claude-code', 'codex', 'opencode']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const directory of ['.claude/skills/chosen', '.agents/skills/chosen']) {
      assert.equal(readFileSync(path.join(workspace, directory, 'references/detail.md'), 'utf8'), 'Preserve this resource');
    }
    assert.equal(existsSync(path.join(workspace, '.agents/skills/unselected')), false);
    assert.equal(JSON.parse(readFileSync(path.join(workspace, 'skills-lock.json'), 'utf8')).skills.legacy.extra, 'keep');
    const refused = run(['add', source, '--skill', 'chosen', '--agent', 'codex']);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /scope/);
    const duplicate = run(['add', source, '--project', '--skill', 'chosen', '--agent', 'codex']);
    assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /Existing installation/);
    const target = path.join(workspace, '.agents/skills/chosen');
    const alias = path.join(workspace, '.claude/skills/alias'); symlinkSync(target, alias);
    const shared = run(['add', source, '--project', '--skill', 'chosen', '--agent', 'codex', '--replace', '--expected-path', target]);
    assert.notEqual(shared.status, 0); assert.match(shared.stderr, /shared aliases/);
    const inventory = JSON.parse(execFileSync(process.execPath, [cli, 'inventory'], { cwd: workspace, env, encoding: 'utf8' }));
    const selected = inventory.skills.find((skill: { aliases: string[]; installPath: string }) => skill.aliases.some(value => value.endsWith('/.claude/skills/alias')) || skill.installPath.endsWith('/.claude/skills/alias'));
    assert.ok(selected);
    const removed = run(['remove', '--path', alias, '--real-path', selected.realPath]);
    assert.equal(removed.status, 0, removed.stderr); assert.equal(existsSync(alias), false); assert.ok(existsSync(target));
    // A cyclic source resource causes a real upstream copy failure after SKILL.md
    // has been copied. File presence must not turn that partial result into success.
    const cycle = path.join(source, 'skills/chosen/references/cycle');
    symlinkSync(cycle, cycle);
    const failed = run(['add', source, '--project', '--skill', 'chosen', '--agent', 'codex', '--replace', '--expected-path', target]);
    assert.notEqual(failed.status, 0, failed.stdout);
    assert.match(failed.stdout, /"status": "failed"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reports failed discovery distinctly from an empty successful search', () => {
  const result = spawnSync(process.execPath, [cli, 'find'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires a search query/); assert.doesNotMatch(result.stdout, /"skills": \[\]/);
});

it('searches selected hubs and installs, updates and removes an archive Skill with reusable provenance', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const root = mkdtempSync(path.join(tmpdir(), 'comate-hub-cli-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const fixture = path.join(root, 'fixture');
  for (const dir of [workspace, home, fixture]) mkdirSync(dir);
  const writeArchive = (version: string) => {
    writeFileSync(path.join(fixture, 'SKILL.md'), `---\nname: hub-demo\ndescription: Hub demo\nmetadata:\n  version: "${version}"\n---\nRead detail.txt`);
    writeFileSync(path.join(fixture, 'detail.txt'), version);
    execFileSync('zip', ['-q', '-j', path.join(root, 'skill.zip'), 'SKILL.md', 'detail.txt'], { cwd: fixture });
  };
  writeArchive('1.0');
  let failDownload = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/download/')) {
      if (failDownload) { res.writeHead(503).end(); return; }
      res.end(readFileSync(path.join(root, 'skill.zip'))); return;
    }
    if (req.url?.startsWith('/skills?')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ items: [{ slug: 'hub-demo', displayName: 'Hub demo', summary: 'Test' }] })); return;
    }
    res.writeHead(503).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: '', COMATE_SKILL_ISOLATED: '0', SKILLS_API_URL: base, XFYUN_SKILLS_API_URL: base };
  const run = (args: string[]) => exec(process.execPath, [cli, ...args], { cwd: workspace, env, timeout: 30000 });
  try {
    const found = JSON.parse((await run(['find', 'demo', '--providers', 'skills.sh,xfyun'])).stdout);
    assert.equal(found.status, 'partial');
    assert.equal(found.providers.length, 2);
    assert.equal(found.skills[0].installSource, 'xfyun:hub-demo');
    await assert.rejects(run(['find', 'demo', '--providers', 'skills.sh']));
    await assert.rejects(run(['find', 'demo', '--providers', 'unknown']));
    const listed = await run(['add', 'xfyun:hub-demo', '--list']);
    assert.match(listed.stdout, /hub-demo/);
    const target = path.join(workspace, '.agents/skills/hub-demo');
    assert.equal(existsSync(target), false);
    const add = ['add', 'xfyun:hub-demo', '--project', '--skill', 'hub-demo', '--agent', 'codex'];
    await run(add);
    let installed = JSON.parse((await run(['inventory'])).stdout).skills.find((s: { name: string; scope: string }) => s.name === 'hub-demo' && s.scope === 'project');
    assert.equal(installed.source, 'xfyun:hub-demo');
    assert.equal(installed.version, '1.0');
    await run(['add', 'xfyun:hub-demo', '--global', '--skill', 'hub-demo', '--agent', 'codex']);
    const userInstall = JSON.parse((await run(['inventory'])).stdout).skills.find((s: { name: string; scope: string }) => s.name === 'hub-demo' && s.scope === 'global');
    assert.equal(userInstall.source, 'xfyun:hub-demo');
    const userTarget = userInstall.installPath;
    const update = [...add, '--replace', '--expected-path', target];
    writeArchive('2.0');
    failDownload = true;
    await assert.rejects(run(update));
    assert.equal(readFileSync(path.join(target, 'detail.txt'), 'utf8'), '1.0');
    failDownload = false;
    await run(update);
    installed = JSON.parse((await run(['inventory'])).stdout).skills.find((s: { name: string; scope: string }) => s.name === 'hub-demo' && s.scope === 'project');
    assert.equal(installed.source, 'xfyun:hub-demo');
    assert.equal(installed.version, '2.0');
    assert.equal(readFileSync(path.join(userTarget, 'detail.txt'), 'utf8'), '1.0');
    assert.equal(readFileSync(path.join(target, 'detail.txt'), 'utf8'), '2.0');
    await run(['remove', '--path', installed.installPath, '--real-path', installed.realPath]);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(userTarget), true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
