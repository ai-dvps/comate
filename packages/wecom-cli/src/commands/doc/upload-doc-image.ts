import { Flags } from '@oclif/core';
import { BaseDocCommand } from './base-doc-command.js';

export default class UploadDocImage extends BaseDocCommand {
  static override description = 'Upload an image to a WeCom document';

  static override flags = {
    docid: Flags.string({ description: 'Document ID', required: true }),
    'file-path': Flags.string({ description: 'Path to the image file', required: true }),
    json: Flags.string({ description: 'Raw JSON request body (overrides flags)', required: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(UploadDocImage);
    if (flags.json) {
      const body = JSON.parse(flags.json) as Record<string, unknown>;
      await this.callDocTool('upload-doc-image', body);
      return;
    }
    const body: Record<string, unknown> = {};
    if (flags.docid !== undefined) body.docid = flags.docid;
    if (flags['file-path'] !== undefined) body.file_path = flags['file-path'];
    await this.callDocTool('upload-doc-image', body);
  }
}
