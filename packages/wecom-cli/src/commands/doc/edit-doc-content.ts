import { BaseDocCommand } from './base-doc-command.js';

export default class EditDocContent extends BaseDocCommand {
  static override description = 'TODO: description';
  // Flags and run() will be added in U4/U5

  async run(): Promise<void> {
    await this.callDocTool('edit-doc-content', this.flagsAsParams());
  }

  private flagsAsParams(): Record<string, unknown> {
    return {};
  }
}
