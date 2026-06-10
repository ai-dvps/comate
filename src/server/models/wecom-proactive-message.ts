export type ProactiveMessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface WeComProactiveMessage {
  id: string;
  workspaceId: string;
  senderSessionId: string;
  recipientEncryptedUserId: string;
  recipientPlaintextUserId: string;
  messageContent: string;
  status: ProactiveMessageStatus;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  claimedAt: string | null;
  retryCount: number;
}

export interface CreateProactiveMessageInput {
  senderSessionId: string;
  recipientEncryptedUserId: string;
  recipientPlaintextUserId: string;
  messageContent: string;
}

export interface UpdateProactiveMessageInput {
  status?: ProactiveMessageStatus;
  errorReason?: string | null;
  deliveredAt?: string | null;
  claimedAt?: string | null;
  retryCount?: number;
}
