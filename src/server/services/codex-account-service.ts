import type { GetAccountResponse } from '../generated/codex-protocol/v2/GetAccountResponse.js';
import type { LoginAccountParams } from '../generated/codex-protocol/v2/LoginAccountParams.js';
import type { LoginAccountResponse } from '../generated/codex-protocol/v2/LoginAccountResponse.js';
import type { ModelListResponse } from '../generated/codex-protocol/v2/ModelListResponse.js';
import { codexAppServerManager, type CodexAppServerManager } from './codex-app-server-manager.js';

export class CodexAccountService {
  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

  async read(): Promise<GetAccountResponse> {
    return this.manager.request('account/read', {});
  }

  async login(params: LoginAccountParams): Promise<LoginAccountResponse> {
    return this.manager.request('account/login/start', params);
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.manager.request('account/login/cancel', { loginId });
  }

  async logout(): Promise<void> {
    await this.manager.request('account/logout');
  }

  async listModels(): Promise<ModelListResponse> {
    return this.manager.request('model/list', {});
  }
}

export const codexAccountService = new CodexAccountService();
