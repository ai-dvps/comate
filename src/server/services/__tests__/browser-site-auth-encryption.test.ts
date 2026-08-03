import '../../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import type { BrowserSiteAuthEntry } from '../../models/workspace.js';
import { SqliteStore } from '../../storage/sqlite-store.js';
import { __setCredentialKey, deriveKeyFromPassphrase } from '../../utils/credential-crypto.js';
import {
  BrowserSiteAuthReadError,
  readGlobalSiteAuthEntry,
  readSiteAuthEntry,
} from '../browser-site-auth.js';

const SECRET = 'u5a-plaintext-sentinel-must-not-live-in-sqlite';
const entry: BrowserSiteAuthEntry = {
  sessionContext: { cookies: [{ name: 'sid', value: SECRET, domain: '.example.com' }] },
  bearerToken: `bearer-${SECRET}`,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

const dirs: string[] = [];
afterEach(() => {
  __setCredentialKey(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFileStore(): { store: SqliteStore; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'comate-u5a-auth-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'data.db');
  return { store: new SqliteStore(dbPath), dbPath };
}

describe('remembered site-auth encryption', () => {
  it('encrypts workspace and global values at rest while safe readers decrypt them', async () => {
    __setCredentialKey(deriveKeyFromPassphrase('u5a-key-a'));
    const { store, dbPath } = makeFileStore();
    const workspace = await store.create({ name: 'test', folderPath: '/tmp/test' });
    store.setWorkspaceSiteAuthEntry(workspace.id, 'example.com', entry);
    store.setGlobalSiteAuth('example.com', JSON.stringify(entry));

    assert.equal(readFileSync(dbPath).includes(Buffer.from(SECRET)), false);
    assert.equal(readSiteAuthEntry((await store.get(workspace.id))!.settings, 'example.com')!
      .sessionContext.cookies[0].value, SECRET);
    assert.equal(readGlobalSiteAuthEntry(store, 'example.com')!.entry.bearerToken, `bearer-${SECRET}`);
  });

  it('migrates legacy plaintext on workspace/global server reads', async () => {
    __setCredentialKey(deriveKeyFromPassphrase('u5a-key-a'));
    const { store, dbPath } = makeFileStore();
    const workspace = await store.create({ name: 'test', folderPath: '/tmp/test' });
    const raw = new Database(dbPath);
    raw.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(
      JSON.stringify({ browserSiteAuth: { 'example.com': entry } }), workspace.id,
    );
    raw.prepare('INSERT INTO global_site_auth(site_key, entry_json, updated_at) VALUES (?, ?, ?)')
      .run('example.com', JSON.stringify(entry), entry.updatedAt);

    assert.equal(readSiteAuthEntry((await store.get(workspace.id))!.settings, 'example.com')!
      .sessionContext.cookies[0].value, SECRET);
    assert.equal(readGlobalSiteAuthEntry(store, 'example.com')!.entry.bearerToken, `bearer-${SECRET}`);
    const workspaceJson = raw.prepare('SELECT settings FROM workspaces WHERE id = ?').get(workspace.id) as { settings: string };
    const globalJson = raw.prepare('SELECT entry_json FROM global_site_auth WHERE site_key = ?').get('example.com') as { entry_json: string };
    assert.equal(workspaceJson.settings.includes(SECRET), false);
    assert.equal(globalJson.entry_json.includes(SECRET), false);
    raw.close();
  });

  it('returns only typed reauthentication_needed for corruption or the wrong key', async () => {
    __setCredentialKey(deriveKeyFromPassphrase('u5a-key-a'));
    const { store } = makeFileStore();
    const workspace = await store.create({ name: 'test', folderPath: '/tmp/test' });
    const updated = store.setWorkspaceSiteAuthEntry(workspace.id, 'example.com', entry)!;
    __setCredentialKey(deriveKeyFromPassphrase('u5a-key-b'));
    assert.throws(() => readSiteAuthEntry(updated.settings, 'example.com'),
      (error: unknown) => error instanceof BrowserSiteAuthReadError &&
        error.code === 'reauthentication_needed' && !error.message.includes(SECRET));

    __setCredentialKey(deriveKeyFromPassphrase('u5a-key-a'));
    store.setGlobalSiteAuth('example.com', JSON.stringify(entry));
    const rawStore = store as unknown as { db: Database.Database };
    const rawJson = rawStore.db.prepare('SELECT entry_json FROM global_site_auth WHERE site_key = ?')
      .get('example.com') as { entry_json: string };
    const envelope = JSON.parse(rawJson.entry_json) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    rawStore.db.prepare('UPDATE global_site_auth SET entry_json = ? WHERE site_key = ?')
      .run(JSON.stringify(envelope), 'example.com');
    assert.throws(() => readGlobalSiteAuthEntry(store, 'example.com'),
      (error: unknown) => error instanceof BrowserSiteAuthReadError &&
        error.code === 'reauthentication_needed' && !error.message.includes(SECRET));
  });
});
