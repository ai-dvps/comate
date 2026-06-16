import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetUpdateRecordsAutoFile extends BaseDocCommand {
  static override description = 'TODO: description';
  // Flags and run() will be added in U4/U5

  async run(): Promise<void> {
    await this.callDocTool('smartsheet-update-records-auto-file', this.flagsAsParams());
  }

  private flagsAsParams(): Record<string, unknown> {
    return {};
  }
}
