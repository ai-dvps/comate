#!/usr/bin/env node
import { runSkills } from './commands/skills.js';
import { runApiRequest } from './commands/api/request.js';

function parseArgs(argv: string[]): { recipePath?: string; stdin: boolean; json: boolean } {
  if (argv[0] !== 'api' || argv[1] !== 'request') {
    throw new Error('Usage: comate api request (--recipe <path> | --stdin) [--json]');
  }
  let recipePath: string | undefined;
  let stdin = false;
  let json = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--recipe') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--recipe requires a file path.');
      recipePath = value;
    } else if (arg === '--stdin') stdin = true;
    else if (arg === '--json') json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { ...(recipePath ? { recipePath } : {}), stdin, json };
}

async function main(): Promise<void> {
  try {
    if (process.argv[2] === 'skills') { process.exitCode = await runSkills(process.argv.slice(3)); return; }
    process.exitCode = await runApiRequest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request failed.';
    process.stderr.write(`comate: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
