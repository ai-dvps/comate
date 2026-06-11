import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const mdPath = join(rootDir, 'src', 'server', 'assets', 'send-wecom-msg.md');
const tsPath = join(rootDir, 'src', 'server', 'assets', 'wecom-skill.ts');

const mdContent = readFileSync(mdPath, 'utf-8');
const escaped = mdContent
  .replace(/\\/g, '\\\\')
  .replace(/\$/g, '\\$')
  .replace(/`/g, '\\`');

const tsContent = `// Auto-generated from send-wecom-msg.md. Do not edit directly.
export const SKILL_MD = \`${escaped}\`;
`;

writeFileSync(tsPath, tsContent, 'utf-8');
console.log(`Generated ${tsPath} from ${mdPath}`);
