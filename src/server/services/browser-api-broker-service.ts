import type { BrokerResult } from '@comate/api-contracts';
import {
  BrowserAuthenticatedRequestBroker,
  type BrokerExecutionContext,
} from './browser-authenticated-request.js';
import { browserAuditService } from './browser-audit.js';
import { browserService } from './browser-service.js';

export interface BrowserApiBrokerExecutor {
  execute(context: BrokerExecutionContext, request: unknown): Promise<BrokerResult>;
}

export interface ApiBrokerApprovalRequest {
  taskId: string;
  method: string;
  siteKey: string;
  destination: string;
  bodySummary?: import('@comate/api-contracts').SanitizedDisclosure;
  correlationId: string;
  validationRequested: boolean;
  signal?: AbortSignal;
}

export type ApiBrokerApprovalRequester = (
  input: ApiBrokerApprovalRequest,
) => Promise<{ behavior: 'allow' | 'deny' }>;

/**
 * Process-wide broker shared by MCP and the loopback CLI route. Its exact
 * operation grants therefore survive stateless HTTP/MCP requests, while the
 * caller-provided runtime generation keeps them scoped to one live runtime.
 */
class BrowserApiBrokerService {
  private approvalRequester?: ApiBrokerApprovalRequester;
  private readonly broker = new BrowserAuthenticatedRequestBroker({
    resolveAuth: (taskId, bindingId, destination) =>
      browserService.resolveAuthBinding(taskId, bindingId, destination),
    approvalRequester: async (input) => {
      if (!this.approvalRequester) return { behavior: 'deny' };
      return this.approvalRequester(input);
    },
    audit: browserAuditService,
  });

  configureApprovalRequester(requester: ApiBrokerApprovalRequester): void {
    this.approvalRequester = requester;
  }

  execute(
    context: BrokerExecutionContext,
    request: unknown,
  ): Promise<BrokerResult> {
    return this.broker.execute(context, request);
  }

  /** Runtime/task terminal hook: exact-operation approvals must not survive. */
  revokeTask(taskId: string): void {
    this.broker.revokeTask(taskId);
  }
}

export const browserApiBrokerService = new BrowserApiBrokerService();
