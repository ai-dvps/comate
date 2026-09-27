import { chmod, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';

export async function buildSkillsCli(outfile = resolve('dist/skills-cli/bundle.cjs')) {
  await build({
    entryPoints: [resolve('scripts/skills-cli-entry.ts')], outfile,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    define: { 'import.meta.url': 'undefined' },
    plugins: [{
      name: 'disable-upstream-telemetry',
      setup(builder) {
        builder.onLoad({ filter: /vercel-skills\/src\/add\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const anchor = 'if (failed.length > 0) {';
          if (source.split(anchor).length !== 3) throw new Error('Skills CLI failure reporting changed; review the pinned integration');
          return { contents: source.replaceAll(anchor, `${anchor}\nprocess.exitCode = 1;`), loader: 'ts' };
        });
        builder.onLoad({ filter: /vercel-skills\/src\/telemetry\.ts$/ }, () => ({
          contents: 'export function setDetectedAgent() {} export function setVersion() {} export function track() {} export async function flushTelemetry() {} export async function fetchAuditData() { return null; }',
          loader: 'js',
        }));
      },
    }],
  });
  await chmod(outfile, 0o755);
}
if (process.argv[1]?.endsWith('build-skills-cli.ts')) await buildSkillsCli();
