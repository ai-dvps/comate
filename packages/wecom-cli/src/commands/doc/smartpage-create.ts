import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class SmartpageCreate extends BaseDocCommand {
  static override description = 'Create a smartpage from a local markdown file';

  static override flags = {
    title: Flags.string({ description: 'Page title', required: false }),
    'page-filepath': Flags.string({ description: 'Path to local markdown file (relative to workspace root)', required: false }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SmartpageCreate);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('smartpage-create', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.title) body.title = flags.title;
    if (flags['page-filepath']) body.page_filepath = flags['page-filepath'];
    await this.callDocTool('smartpage-create', body);
  }
}
