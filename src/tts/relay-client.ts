/**
 * TTS Relay Client
 *
 * Connects ChapterX bots to the TTS relay server for streaming text
 * to local TTS clients (Melodeus).
 */

import WebSocket from 'ws';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'tts-relay' });

// ============================================================================
// Types
// ============================================================================

export type BlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';
export type InterruptionReason = 'user_speech' | 'manual' | 'timeout';

export interface RelayClientConfig {
  url: string;
  botId: string;
  token: string;
  reconnectIntervalMs?: number;
}

export interface ChunkPayload {
  channelId: string;
  userId: string;
  username: string;
  text: string;
  blockIndex: number;
  blockType: BlockType;
  visible: boolean;
}

export interface BlockStartPayload {
  channelId: string;
  userId: string;
  username: string;
  blockIndex: number;
  blockType: BlockType;
}

export interface BlockCompletePayload {
  channelId: string;
  userId: string;
  username: string;
  blockIndex: number;
  blockType: BlockType;
  content: string;
}

export interface InterruptionEvent {
  channelId: string;
  spokenText: string;       // The text that was voiced - match against recent messages
  reason: InterruptionReason;
  timestamp: number;
}

// ============================================================================
// Relay Client
// ============================================================================

export class TTSRelayClient {
  private config: Required<RelayClientConfig>;
  private ws: WebSocket | null = null;
  private authenticated = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private onInterruptionHandler: ((event: InterruptionEvent) => void) | null = null;

  constructor(config: RelayClientConfig) {
    this.config = {
      reconnectIntervalMs: 5000,
      ...config,
    };
  }

  /**
   * Connect to the relay server
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('Already connected to relay');
      return;
    }

    this.shouldReconnect = true;
    return this.doConnect();
  }

  /**
   * Disconnect from the relay server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }

    this.authenticated = false;
    logger.info({ botId: this.config.botId }, 'Disconnected from relay');
  }

  /**
   * Check if connected and authenticated
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  /**
   * Set handler for interruption events from TTS clients
   */
  onInterruption(handler: (event: InterruptionEvent) => void): void {
    this.onInterruptionHandler = handler;
  }

  /**
   * Send a text chunk to the relay
   */
  sendChunk(payload: ChunkPayload): void {
    if (!this.isConnected()) {
      logger.debug('Cannot send chunk: not connected');
      return;
    }

    const message = {
      type: 'chunk',
      botId: this.config.botId,
      ...payload,
      timestamp: Date.now(),
    };

    this.send(message);
  }

  /**
   * Send a block_start event to the relay
   */
  sendBlockStart(payload: BlockStartPayload): void {
    if (!this.isConnected()) {
      logger.debug('Cannot send block_start: not connected');
      return;
    }

    const message = {
      type: 'block_start',
      botId: this.config.botId,
      ...payload,
      timestamp: Date.now(),
    };

    this.send(message);
  }

  /**
   * Send a block_complete event to the relay
   */
  sendBlockComplete(payload: BlockCompletePayload): void {
    if (!this.isConnected()) {
      logger.debug('Cannot send block_complete: not connected');
      return;
    }

    const message = {
      type: 'block_complete',
      botId: this.config.botId,
      ...payload,
      timestamp: Date.now(),
    };

    this.send(message);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.url}`;

      logger.info({ url, botId: this.config.botId }, 'Connecting to relay');

      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        logger.error({ error }, 'Failed to create WebSocket');
        this.scheduleReconnect();
        reject(error);
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (!this.authenticated) {
          logger.error('Connection timeout');
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        logger.debug('WebSocket connected, authenticating...');
        this.authenticate();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data, resolve, reject, connectTimeout);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectTimeout);
        this.authenticated = false;
        logger.info(
          { code, reason: reason.toString(), botId: this.config.botId },
          'Relay connection closed'
        );
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        clearTimeout(connectTimeout);
        logger.error({ error, botId: this.config.botId }, 'Relay WebSocket error');
      });
    });
  }

  private authenticate(): void {
    const authMessage = {
      type: 'auth',
      botId: this.config.botId,
      token: this.config.token,
    };
    this.send(authMessage);
  }

  private handleMessage(
    data: WebSocket.Data,
    onConnected: () => void,
    onConnectFailed: (error: Error) => void,
    connectTimeout: NodeJS.Timeout
  ): void {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      logger.warn('Invalid JSON from relay');
      return;
    }

    switch (message.type) {
      case 'auth_ok':
        clearTimeout(connectTimeout);
        this.authenticated = true;
        logger.info({ botId: this.config.botId }, 'Authenticated with relay');
        onConnected();
        break;

      case 'auth_error':
        clearTimeout(connectTimeout);
        logger.error({ error: message.error }, 'Relay authentication failed');
        this.shouldReconnect = false; // Don't reconnect on auth failure
        onConnectFailed(new Error(message.error));
        break;

      case 'interruption':
        this.handleInterruption(message);
        break;

      default:
        logger.debug({ type: message.type }, 'Unknown message type from relay');
    }
  }

  private handleInterruption(message: any): void {
    const event: InterruptionEvent = {
      channelId: message.channelId,
      spokenText: message.spokenText,
      reason: message.reason,
      timestamp: message.timestamp,
    };

    logger.info(
      { channelId: event.channelId, reason: event.reason, spokenLength: event.spokenText.length },
      'Received interruption from relay'
    );

    if (this.onInterruptionHandler) {
      this.onInterruptionHandler(event);
    }
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        logger.error({ error }, 'Failed to send message to relay');
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      logger.info({ botId: this.config.botId }, 'Attempting to reconnect to relay');
      this.doConnect().catch(() => {
        // Error already logged, reconnect will be scheduled
      });
    }, this.config.reconnectIntervalMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
