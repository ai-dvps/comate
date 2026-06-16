import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '../models/workspace.js';
import { WeComMcpClient } from './wecom-mcp-client.js';

const IMAGE_SIZE_LIMIT = 30 * 1024 * 1024;
const FILE_SIZE_LIMIT = 10 * 1024 * 1024;

interface ImageUploadResult {
  url: string;
  title?: string;
}

interface FileUploadResult {
  fileid: string;
}

/**
 * Server-side WeCom document service.
 *
 * Proxies `wecom doc:*` CLI tools to the WeCom doc MCP endpoint while running
 * local helpers that the Rust `wecom-cli` used to run client-side:
 *
 * - `smartpage-create`: reads local `page_filepath` files as UTF-8 and
 *   substitutes `page_content` before calling `smartpage_create`.
 * - `smartsheet-add-records-auto-file` / `smartsheet-update-records-auto-file`:
 *   base64-encode local files, call `upload_doc_image` / `upload_doc_file`, and
 *   substitute `image_path` → `image_url` / `file_path` → `file_id` before
 *   forwarding to `smartsheet_add_records` / `smartsheet_update_records`.
 */
export class WeComDocService {
  private mcpClient = new WeComMcpClient();

  async callTool(
    workspace: Workspace,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const botId = workspace.settings.wecomBotId;
    const botSecret = workspace.settings.wecomBotSecret;

    if (!botId || !botSecret) {
      throw new Error('Workspace is missing WeCom bot credentials');
    }

    let remoteMethod = kebabToSnake(tool);
    let args: Record<string, unknown> = { ...params };

    if (tool === 'smartpage-create') {
      args = await this.processSmartpageCreate(args, workspace.folderPath);
    } else if (tool === 'smartsheet-add-records-auto-file') {
      args = await this.processSmartsheetRecords(args, workspace.folderPath, botId, botSecret);
      remoteMethod = 'smartsheet_add_records';
    } else if (tool === 'smartsheet-update-records-auto-file') {
      args = await this.processSmartsheetRecords(args, workspace.folderPath, botId, botSecret);
      remoteMethod = 'smartsheet_update_records';
    }

    return this.mcpClient.callJsonTool(botId, botSecret, 'doc', remoteMethod, args);
  }

  private async processSmartpageCreate(
    params: Record<string, unknown>,
    folderPath: string,
  ): Promise<Record<string, unknown>> {
    // TypeScript CLI simplification: single top-level page_filepath.
    if (typeof params.page_filepath === 'string') {
      const filePath = path.resolve(folderPath, params.page_filepath);
      const content = await fsPromises.readFile(filePath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { page_filepath: _, ...rest } = params;
      return {
        ...rest,
        pages: [{ title: params.title, page_content: content }],
      };
    }

    // Rust CLI convention: pages array with page_filepath entries.
    if (Array.isArray(params.pages)) {
      const pages = await Promise.all(
        params.pages.map(async (page) => {
          if (typeof page !== 'object' || page === null) {
            return page;
          }
          const p = page as Record<string, unknown>;
          if (typeof p.page_filepath !== 'string') {
            return page;
          }
          const filePath = path.resolve(folderPath, p.page_filepath);
          const content = await fsPromises.readFile(filePath, 'utf-8');
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { page_filepath: _, ...rest } = p;
          return { ...rest, page_content: content };
        }),
      );
      return { ...params, pages };
    }

    return params;
  }

  private async processSmartsheetRecords(
    params: Record<string, unknown>,
    folderPath: string,
    botId: string,
    botSecret: string,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(params.records)) {
      throw new Error('Missing records array');
    }

    const records = params.records.map((record) =>
      typeof record === 'object' && record !== null
        ? ({ ...(record as Record<string, unknown>) } as Record<string, unknown>)
        : (record as Record<string, unknown>),
    );

    const imagePaths = new Set<string>();
    const filePaths = new Set<string>();

    for (const record of records) {
      const valuesKey = getValuesKey(record);
      if (!valuesKey) continue;
      const values = record[valuesKey] as Record<string, unknown>;
      for (const cell of Object.values(values)) {
        collectUploadPaths(cell, imagePaths, filePaths);
      }
    }

    const imageMap =
      imagePaths.size > 0
        ? await this.uploadImages([...imagePaths], folderPath, params, botId, botSecret)
        : new Map<string, ImageUploadResult>();
    const fileMap =
      filePaths.size > 0
        ? await this.uploadFiles([...filePaths], folderPath, botId, botSecret)
        : new Map<string, FileUploadResult>();

    for (const record of records) {
      const valuesKey = getValuesKey(record);
      if (!valuesKey) continue;
      const values = record[valuesKey] as Record<string, unknown>;
      for (const [fieldKey, cell] of Object.entries(values)) {
        values[fieldKey] = replaceUploadResults(cell, imageMap, fileMap);
      }
    }

    return { ...params, records };
  }

  private async uploadImages(
    paths: string[],
    folderPath: string,
    params: Record<string, unknown>,
    botId: string,
    botSecret: string,
  ): Promise<Map<string, ImageUploadResult>> {
    const map = new Map<string, ImageUploadResult>();
    for (const imagePath of paths) {
      const resolvedPath = path.resolve(folderPath, imagePath);
      const base64 = await readFileAsBase64(resolvedPath, IMAGE_SIZE_LIMIT);
      const args: Record<string, unknown> = { base64_content: base64 };
      if (typeof params.docid === 'string') {
        args.docid = params.docid;
      } else if (typeof params.url === 'string') {
        args.url = params.url;
      }
      const res = await this.mcpClient.callJsonTool(
        botId,
        botSecret,
        'doc',
        'upload_doc_image',
        args,
      );
      const url = typeof res.url === 'string' ? res.url : '';
      if (!url) {
        throw new Error(`Image upload failed for ${imagePath}: missing url`);
      }
      const title = path.basename(imagePath);
      map.set(imagePath, { url, title });
    }
    return map;
  }

  private async uploadFiles(
    paths: string[],
    folderPath: string,
    botId: string,
    botSecret: string,
  ): Promise<Map<string, FileUploadResult>> {
    const map = new Map<string, FileUploadResult>();
    for (const filePath of paths) {
      const resolvedPath = path.resolve(folderPath, filePath);
      const base64 = await readFileAsBase64(resolvedPath, FILE_SIZE_LIMIT);
      const fileName = path.basename(filePath);
      const res = await this.mcpClient.callJsonTool(botId, botSecret, 'doc', 'upload_doc_file', {
        file_name: fileName,
        file_base64_content: base64,
      });
      const fileid = typeof res.fileid === 'string' ? res.fileid : '';
      if (!fileid) {
        throw new Error(`File upload failed for ${filePath}: missing fileid`);
      }
      map.set(filePath, { fileid });
    }
    return map;
  }
}

function kebabToSnake(input: string): string {
  return input.replace(/-/g, '_');
}

function getValuesKey(record: Record<string, unknown>): 'field_values' | 'values' | undefined {
  if ('field_values' in record) return 'field_values';
  if ('values' in record) return 'values';
  return undefined;
}

function collectUploadPaths(
  cell: unknown,
  imagePaths: Set<string>,
  filePaths: Set<string>,
): void {
  if (Array.isArray(cell)) {
    for (const item of cell) {
      collectItemPaths(item, imagePaths, filePaths);
    }
  } else {
    collectItemPaths(cell, imagePaths, filePaths);
  }
}

function collectItemPaths(
  item: unknown,
  imagePaths: Set<string>,
  filePaths: Set<string>,
): void {
  if (typeof item !== 'object' || item === null) return;
  const obj = item as Record<string, unknown>;
  if (typeof obj.image_path === 'string') imagePaths.add(obj.image_path);
  if (typeof obj.file_path === 'string') filePaths.add(obj.file_path);
}

function replaceUploadResults(
  cell: unknown,
  imageMap: Map<string, ImageUploadResult>,
  fileMap: Map<string, FileUploadResult>,
): unknown {
  if (Array.isArray(cell)) {
    return cell.map((item) => replaceItemResults(item, imageMap, fileMap));
  }
  return replaceItemResults(cell, imageMap, fileMap);
}

function replaceItemResults(
  item: unknown,
  imageMap: Map<string, ImageUploadResult>,
  fileMap: Map<string, FileUploadResult>,
): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const obj = { ...(item as Record<string, unknown>) };
  if (typeof obj.image_path === 'string' && imageMap.has(obj.image_path)) {
    const result = imageMap.get(obj.image_path)!;
    delete obj.image_path;
    obj.image_url = result.url;
    if (result.title) obj.title = result.title;
  }
  if (typeof obj.file_path === 'string' && fileMap.has(obj.file_path)) {
    const result = fileMap.get(obj.file_path)!;
    delete obj.file_path;
    obj.file_id = result.fileid;
  }
  return obj;
}

async function readFileAsBase64(filePath: string, maxSize: number): Promise<string> {
  const data = await fsPromises.readFile(filePath);
  if (data.length > maxSize) {
    const actualMb = (data.length / 1024 / 1024).toFixed(1);
    const limitMb = (maxSize / 1024 / 1024).toFixed(1);
    throw new Error(`File ${filePath} size is ${actualMb} MB, exceeds limit ${limitMb} MB`);
  }
  return data.toString('base64');
}

export const wecomDocService = new WeComDocService();
