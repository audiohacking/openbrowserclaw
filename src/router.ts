// ---------------------------------------------------------------------------
// OpenBrowserClaw — Message router
// ---------------------------------------------------------------------------
//
// Optional channels (Telegram, Bluesky, Matrix) are passed as getters so they
// can be lazy-loaded only when configured — avoids pulling in heavy SDKs at startup.

import type { Channel } from './types.js';
import type { BrowserChatChannel } from './channels/browser-chat.js';

/**
 * Routes outbound messages and typing indicators to the correct channel
 * based on the groupId prefix.
 *
 * Prefix mapping:
 *   "br:"   → BrowserChatChannel
 *   "tg:"   → TelegramChannel (if loaded)
 *   "bsky:" → BlueskyChannel (if loaded)
 *   "mx:"   → MatrixChannel (if loaded)
 */
export class Router {
  constructor(
    private browserChat: BrowserChatChannel,
    private getTelegram: () => Channel | null,
    private getBluesky: () => Channel | null,
    private getMatrix: () => Channel | null,
  ) {}

  /**
   * Send a message to the correct channel.
   */
  async send(groupId: string, text: string): Promise<void> {
    const channel = this.findChannel(groupId);
    if (!channel) {
      console.warn(`No channel for groupId: ${groupId}`);
      return;
    }
    await channel.send(groupId, text);
  }

  /**
   * Set typing indicator on the correct channel.
   */
  setTyping(groupId: string, typing: boolean): void {
    const channel = this.findChannel(groupId);
    channel?.setTyping(groupId, typing);
  }

  /**
   * Strip internal tags from agent output (matches NanoClaw pattern).
   */
  static formatOutbound(rawText: string): string {
    return rawText.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  }

  /**
   * Format messages in XML for agent context (matches NanoClaw pattern).
   */
  static formatMessagesXml(
    messages: Array<{ sender: string; content: string; timestamp: number }>,
  ): string {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const lines = messages.map(
      (m) =>
        `<message sender="${escapeXml(m.sender)}" time="${new Date(m.timestamp).toISOString()}">${escapeXml(m.content)}</message>`,
    );
    return `<messages>\n${lines.join('\n')}\n</messages>`;
  }

  private findChannel(groupId: string): Channel | null {
    if (groupId.startsWith('tg:')) {
      return this.getTelegram();
    }
    if (groupId.startsWith('bsky:')) {
      return this.getBluesky();
    }
    if (groupId.startsWith('mx:')) {
      return this.getMatrix();
    }
    return this.browserChat;
  }
}
