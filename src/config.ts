// ---------------------------------------------------------------------------
// OpenBrowserClaw — Configuration constants
// ---------------------------------------------------------------------------

/** Default assistant name (used in trigger pattern) */
export const ASSISTANT_NAME = 'Andy';

/** Trigger pattern — messages must match this to invoke the agent */
export function buildTriggerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}\\b`, 'i');
}

export const TRIGGER_PATTERN = buildTriggerPattern(ASSISTANT_NAME);

/** How many recent messages to include in agent context */
export const CONTEXT_WINDOW_SIZE = 50;

/** Max tokens for Claude API response */
export const DEFAULT_MAX_TOKENS = 8096;

/** Default provider */
export const DEFAULT_PROVIDER = 'anthropic';

/** Default model */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Anthropic API endpoint */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/** Anthropic API version header */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default Ollama URL */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Telegram Bot API base URL */
export const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/** Telegram message length limit */
export const TELEGRAM_MAX_LENGTH = 4096;

/** Telegram long-poll timeout in seconds */
export const TELEGRAM_POLL_TIMEOUT = 30;

/** Bluesky service URL */
export const BLUESKY_SERVICE = 'https://bsky.social';

/** Bluesky DM poll interval (ms) */
export const BLUESKY_POLL_INTERVAL = 5_000;

/** Task scheduler check interval (ms) */
export const SCHEDULER_INTERVAL = 60_000;

/** Message processing loop interval (ms) */
export const PROCESS_LOOP_INTERVAL = 100;

/** Fetch tool response truncation limit */
export const FETCH_MAX_RESPONSE = 20_000;

/** IndexedDB database name */
export const DB_NAME = 'openbrowserclaw';

/** IndexedDB version */
export const DB_VERSION = 2;

/** OPFS root directory name */
export const OPFS_ROOT = 'openbrowserclaw';

/** Default group for browser chat */
export const DEFAULT_GROUP_ID = 'br:main';

/**
 * Optional integrations are disabled by default to avoid crashes from heavy SDKs.
 * Set at build time via env: VITE_ENABLE_BLUESKY=true and/or VITE_ENABLE_MATRIX=true
 */
export const ENABLE_BLUESKY = import.meta.env.VITE_ENABLE_BLUESKY === 'true';
export const ENABLE_MATRIX = import.meta.env.VITE_ENABLE_MATRIX === 'true';

/** Config keys */
export const CONFIG_KEYS = {
  ANTHROPIC_API_KEY: 'anthropic_api_key',
  PROVIDER: 'provider',
  OLLAMA_URL: 'ollama_url',
  TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
  TELEGRAM_CHAT_IDS: 'telegram_chat_ids',
  TRIGGER_PATTERN: 'trigger_pattern',
  MODEL: 'model',
  MAX_TOKENS: 'max_tokens',
  PASSPHRASE_SALT: 'passphrase_salt',
  PASSPHRASE_VERIFY: 'passphrase_verify',
  ASSISTANT_NAME: 'assistant_name',
  BLUESKY_IDENTIFIER: 'bluesky_identifier',
  BLUESKY_PASSWORD: 'bluesky_password',
  MATRIX_HOMESERVER: 'matrix_homeserver',
  MATRIX_USER_ID: 'matrix_user_id',
  MATRIX_PASSWORD: 'matrix_password',
} as const;
