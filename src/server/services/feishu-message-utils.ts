import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * Send a plain-text DM to a Feishu user.
 * Callers are responsible for error handling/logging.
 */
export async function sendPlainTextMessage(
  larkClient: lark.Client,
  openId: string,
  text: string,
): Promise<void> {
  await larkClient.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}
