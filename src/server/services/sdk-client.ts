import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface QueryResult {
  query: Query;
  messages: AsyncGenerator<SDKMessage>;
}

export class SdkClient {
  createQuery(prompt: string, options: Options): QueryResult {
    const q = query({ prompt, options });

    async function* messageGenerator(): AsyncGenerator<SDKMessage> {
      for await (const msg of q) {
        yield msg;
      }
    }

    return { query: q, messages: messageGenerator() };
  }
}
