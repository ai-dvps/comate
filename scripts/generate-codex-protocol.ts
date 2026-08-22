import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';
import { normalizeCodexProtocolImports } from './lib/codex-protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'server', 'generated', 'codex-protocol');
const binary = resolveCodexBinary();
if (!binary) throw new Error('Pinned Codex binary is unavailable');
mkdirSync(out, { recursive: true });
execFileSync(binary, ['app-server', 'generate-ts', '--out', out], { stdio: 'inherit' });
normalizeCodexProtocolImports(out);
