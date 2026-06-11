#!/usr/bin/env node
import { execute } from '@oclif/core';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Send from './commands/send.js';

export const COMMANDS: Record<string, unknown> = {
  send: Send,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

void execute({
  loadOptions: {
    root: __dirname,
    pjson: {
      name: '@webank/wecom',
      version: '0.0.2',
      oclif: {
        bin: 'wecom',
        commands: {
          strategy: 'explicit',
          target: `./${basename(__filename)}`,
          identifier: 'COMMANDS',
        },
      },
    },
  },
});
