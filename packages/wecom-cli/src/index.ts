#!/usr/bin/env node
import { execute } from '@oclif/core';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

import Send from './commands/send.js';
import SendFile from './commands/send-file.js';
import CurrentUser from './commands/current-user.js';
import GetDocContent from './commands/doc/get-doc-content.js';
import CreateDoc from './commands/doc/create-doc.js';
import EditDocContent from './commands/doc/edit-doc-content.js';
import SmartpageCreate from './commands/doc/smartpage-create.js';
import SmartpageExportTask from './commands/doc/smartpage-export-task.js';
import SmartpageGetExportResult from './commands/doc/smartpage-get-export-result.js';
import SmartsheetGetSheet from './commands/doc/smartsheet-get-sheet.js';
import SmartsheetAddSheet from './commands/doc/smartsheet-add-sheet.js';
import SmartsheetUpdateSheet from './commands/doc/smartsheet-update-sheet.js';
import SmartsheetDeleteSheet from './commands/doc/smartsheet-delete-sheet.js';
import SmartsheetGetFields from './commands/doc/smartsheet-get-fields.js';
import SmartsheetAddFields from './commands/doc/smartsheet-add-fields.js';
import SmartsheetUpdateFields from './commands/doc/smartsheet-update-fields.js';
import SmartsheetDeleteFields from './commands/doc/smartsheet-delete-fields.js';
import SmartsheetGetRecords from './commands/doc/smartsheet-get-records.js';
import SmartsheetAddRecords from './commands/doc/smartsheet-add-records.js';
import SmartsheetUpdateRecords from './commands/doc/smartsheet-update-records.js';
import SmartsheetDeleteRecords from './commands/doc/smartsheet-delete-records.js';
import UploadDocImage from './commands/doc/upload-doc-image.js';
import UploadDocFile from './commands/doc/upload-doc-file.js';
import SmartsheetAddRecordsAutoFile from './commands/doc/smartsheet-add-records-auto-file.js';
import SmartsheetUpdateRecordsAutoFile from './commands/doc/smartsheet-update-records-auto-file.js';

export const COMMANDS: Record<string, unknown> = {
  send: Send,
  'send-file': SendFile,
  'current-user': CurrentUser,
  'doc:get-doc-content': GetDocContent,
  'doc:create-doc': CreateDoc,
  'doc:edit-doc-content': EditDocContent,
  'doc:smartpage-create': SmartpageCreate,
  'doc:smartpage-export-task': SmartpageExportTask,
  'doc:smartpage-get-export-result': SmartpageGetExportResult,
  'doc:smartsheet-get-sheet': SmartsheetGetSheet,
  'doc:smartsheet-add-sheet': SmartsheetAddSheet,
  'doc:smartsheet-update-sheet': SmartsheetUpdateSheet,
  'doc:smartsheet-delete-sheet': SmartsheetDeleteSheet,
  'doc:smartsheet-get-fields': SmartsheetGetFields,
  'doc:smartsheet-add-fields': SmartsheetAddFields,
  'doc:smartsheet-update-fields': SmartsheetUpdateFields,
  'doc:smartsheet-delete-fields': SmartsheetDeleteFields,
  'doc:smartsheet-get-records': SmartsheetGetRecords,
  'doc:smartsheet-add-records': SmartsheetAddRecords,
  'doc:smartsheet-update-records': SmartsheetUpdateRecords,
  'doc:smartsheet-delete-records': SmartsheetDeleteRecords,
  'doc:upload-doc-image': UploadDocImage,
  'doc:upload-doc-file': UploadDocFile,
  'doc:smartsheet-add-records-auto-file': SmartsheetAddRecordsAutoFile,
  'doc:smartsheet-update-records-auto-file': SmartsheetUpdateRecordsAutoFile,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

void execute({
  loadOptions: {
    root: __dirname,
    pjson: {
      name: packageJson.name,
      version: packageJson.version,
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
