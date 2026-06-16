import { BaseDocCommand } from './base-doc-command.js';

export default class SmartsheetGetFields extends BaseDocCommand {
  static override description = 'TODO: description';
  // Flags and run() will be added in U4/U5

  async run(): Promise<void> {
    await this.callDocTool('smartsheet-get-fields', this.flagsAsParams());
  }

  private flagsAsParams(): Record<string, unknown> {
    return {};
  }
}
