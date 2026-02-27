// ---------------------------------------------------------------------------
// OpenBrowserClaw — Matrix Channel
// ---------------------------------------------------------------------------
//
// Uses matrix-js-sdk for Matrix homeserver integration.
// Authenticates with username + password and listens for room messages.
// See: https://github.com/matrix-org/matrix-js-sdk

import {
  createClient,
  RoomEvent,
  EventType,
  MsgType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import type { Channel, InboundMessage } from '../types.js';

type MessageCallback = (msg: InboundMessage) => void;

/**
 * Matrix channel using matrix-js-sdk with username/password authentication.
 * Listens to all joined rooms for incoming messages.
 */
export class MatrixChannel implements Channel {
  readonly type = 'matrix' as const;
  private client: MatrixClient | null = null;
  private homeserverUrl: string = '';
  private userId: string = '';
  private password: string = '';
  private running = false;
  private messageCallback: MessageCallback | null = null;
  // Timestamp at which we started listening — used to ignore history
  private startedAt = 0;
  // Bound handler kept so we can remove the same reference on stop()
  private readonly boundHandleTimelineEvent = this.handleTimelineEvent.bind(this);

  /**
   * Configure the channel with homeserver URL, user ID, and password.
   * userId should be in Matrix format: @user:homeserver.org
   */
  configure(homeserverUrl: string, userId: string, password: string): void {
    this.homeserverUrl = homeserverUrl;
    this.userId = userId;
    this.password = password;
  }

  /**
   * Log in and start listening for messages.
   */
  async start(): Promise<void> {
    if (!this.homeserverUrl || !this.userId || !this.password) return;
    if (this.running) return;

    // Login with a temporary unauthenticated client
    const tmpClient = createClient({ baseUrl: this.homeserverUrl });
    let accessToken: string;
    let deviceId: string;
    let resolvedUserId: string;
    try {
      const res = await tmpClient.login('m.login.password', {
        user: this.userId,
        password: this.password,
        initial_device_display_name: 'browclaw',
      });
      accessToken = res.access_token;
      deviceId = res.device_id;
      resolvedUserId = res.user_id;
    } catch (err) {
      console.error('Matrix login failed:', err);
      return;
    } finally {
      tmpClient.stopClient();
    }

    // Create the authenticated client
    this.client = createClient({
      baseUrl: this.homeserverUrl,
      userId: resolvedUserId,
      accessToken,
      deviceId,
    });

    this.running = true;
    this.startedAt = Date.now();

    // Register event listener before starting to avoid missing events
    this.client.on(RoomEvent.Timeline, this.boundHandleTimelineEvent);

    // Start syncing (initialSyncLimit: 0 prevents loading old messages)
    await this.client.startClient({ initialSyncLimit: 0 });
  }

  /**
   * Stop the Matrix client.
   */
  stop(): void {
    this.running = false;
    if (this.client) {
      this.client.off(RoomEvent.Timeline, this.boundHandleTimelineEvent);
      this.client.stopClient();
      this.client = null;
    }
  }

  /**
   * Send a text message to a Matrix room.
   * groupId must be in the form "mx:<roomId>".
   */
  async send(groupId: string, text: string): Promise<void> {
    if (!this.client) return;
    const roomId = groupId.replace(/^mx:/, '');
    await this.client.sendTextMessage(roomId, text);
  }

  /**
   * Matrix does not expose a simple typing indicator API here.
   */
  setTyping(_groupId: string, _typing: boolean): void {
    // No-op — could call client.sendTyping() but omitted for simplicity
  }

  /**
   * Register callback for inbound room messages.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Check if the channel is configured.
   */
  isConfigured(): boolean {
    return (
      this.homeserverUrl.length > 0 &&
      this.userId.length > 0 &&
      this.password.length > 0
    );
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private handleTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
  ): void {
    if (!this.running || !this.client) return;

    // Only handle text room messages
    if (event.getType() !== EventType.RoomMessage) return;
    const content = event.getContent();
    if (content.msgtype !== MsgType.Text) return;

    // Ignore messages sent before we started (history replay)
    const ts = event.getTs();
    if (ts < this.startedAt) return;

    // Ignore our own messages
    const sender = event.getSender();
    if (sender === this.client.getUserId()) return;

    const roomId = room?.roomId ?? event.getRoomId() ?? '';

    this.messageCallback?.({
      id: event.getId() ?? `mx-${ts}`,
      groupId: `mx:${roomId}`,
      sender: sender ?? 'Unknown',
      content: (content.body as string) || '[Empty message]',
      timestamp: ts,
      channel: 'matrix',
    });
  }
}
