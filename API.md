# Chapter3 REST API

The bot includes an optional REST API for programmatic access to Discord conversation history, user information, and live LLM context.

In production, this is the **Bridge bot** at `borgs.animalabs.ai:3306` — the only chapterx bot launched with `API_BEARER_TOKEN` and `API_PORT` env vars. The infra bot's `/get_prompt` and `/get_context` slash commands proxy to it via `CHAPTERX_API_URL` / `CHAPTERX_API_TOKEN`.

## Quick Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/api/messages/export` | POST | Yes | Export conversation history (follows `.history` commands) |
| `/api/context/build` | POST | Yes | Build live LLM context for a channel (full prompt pipeline) |
| `/api/users/:userId` | GET | Yes | Get user info (username, display name, roles, avatar) |
| `/api/users/:userId/avatar` | GET | Yes | Get user avatar CDN URL |

## Setup

1. Generate a secure API token:
```bash
openssl rand -hex 32 > api_token
```

2. Set environment variable:
```bash
export API_BEARER_TOKEN=$(cat api_token)
export API_PORT=3000  # Optional, defaults to 3000
```

3. Start the bot:
```bash
npm run dev
```

The API server will start alongside the bot and log: `"API server started" { port: 3000 }`. If `API_BEARER_TOKEN` is not set, the API is disabled (`"API server disabled (no API_BEARER_TOKEN set)"`).

### Production: Bridge

In production, the Bridge bot is the canonical API-enabled chapterx bot. Its `borgs-admin` start command is:

```bash
API_BEARER_TOKEN=<bridge-token> API_PORT=3306 EMS_PATH=/opt/chapter2/ems BOT_NAME=Bridge npx tsx src/main.ts
```

The infra bot (LuxiaSL/infra) calls Bridge for `/get_prompt` and `/get_context` via `CHAPTERX_API_URL=http://localhost:3306` + `CHAPTERX_API_TOKEN`. Direct access from outside borgs requires the same bearer token.

## Endpoints

### Health Check
```http
GET /health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-14T23:00:00.000Z"
}
```

**Example:**
```bash
curl http://localhost:3000/health
```

---

### Export Messages
```http
POST /api/messages/export
```

Export Discord conversation history with full metadata. Automatically processes `.history` commands found in channels (uses unified traversal logic with the bot).

**Authentication:** Bearer token required in `Authorization` header

**Request Body:**
```json
{
  "last": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "first": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "recencyWindow": {
    "messages": 400,
    "characters": 100000
  },
  "ignoreHistory": false
}
```

**Parameters:**
- `last` (required): Discord message URL - end point of range
- `first` (optional): Discord message URL - start point of range  
- `recencyWindow` (optional): Limits to apply
  - `messages`: Maximum number of messages (default: 50)
  - `characters`: Maximum total characters
  - If omitted entirely, defaults to 50 messages
- `ignoreHistory` (optional): Skip `.history` command processing (default: **true**)
  - When `true` (default), fetches raw messages without following `.history` redirects or clearing context
  - Set to `false` to process `.history` commands during traversal (matches bot inference behavior)

**Response:**
```json
{
  "messages": [
    {
      "id": "1234567890",
      "author": {
        "id": "9876543210",
        "username": "alice",
        "displayName": "Alice",
        "bot": false
      },
      "content": "Hello world!",
      "timestamp": "2025-11-14T23:00:00.000Z",
      "reactions": [
        {"emoji": "👍", "count": 3},
        {"emoji": "❤️", "count": 1}
      ],
      "attachments": [
        {
          "id": "...",
          "url": "https://cdn.discord.com/...",
          "filename": "image.png",
          "contentType": "image/png",
          "size": 123456,
          "base64Data": "iVBORw0KGgoAAAANSUhEUgAA...",
          "mediaType": "image/png"
        }
      ],
      "referencedMessageId": "1234567889"
    }
  ],
  "metadata": {
    "channelId": "1234567890",
    "guildId": "9876543210",
    "firstMessageId": "1234567880",
    "lastMessageId": "1234567890",
    "totalCount": 100,
    "truncated": false
  }
}
```

---

### Build LLM Context
```http
POST /api/context/build
```

Build the full live LLM context for a channel by running the bot's complete context-builder pipeline (config + steering + plugin injections + tool cache + message merging + recency window + cache markers + stop sequences). Equivalent to a "what would the bot's prompt look like *right now*?" inspection — the same construction used for an actual activation, minus the LLM call.

Bot config takes effect: pinned channel configs, guild overrides, system prompt, mode, model, and stop sequences all match what the bot would use to respond. Character limits are disabled so you can request large windows; the configured `recency_window_messages` becomes the default if `messages` is omitted.

**Authentication:** Bearer token required

**Request Body:**
```json
{
  "channel": "https://discord.com/channels/GUILD_ID/CHANNEL_ID",
  "messages": 500
}
```

**Parameters:**
- `channel` (required): Discord channel URL or numeric channel ID
- `messages` (optional): Number of messages to include. Defaults to the bot's configured `recency_window_messages` (typically 200). `recency_window_characters` and `hard_max_characters` are forced to `Infinity` so this is the only effective cap.

**Response:**
```json
{
  "messages": [
    {
      "participant": "Alice",
      "content": "Hello world!",
      "hasImages": false,
      "imageCount": 0
    },
    {
      "participant": "Claude",
      "content": "Hi Alice!",
      "hasImages": false,
      "imageCount": 0
    }
  ],
  "metadata": {
    "botName": "Claude Fable",
    "channelId": "1398036481146355803",
    "messageCount": 487,
    "discordMessagesFetched": 600,
    "configuredLimit": 500,
    "requestedLimit": 500,
    "model": "claude-fable-5",
    "mode": "chat",
    "systemPrompt": "You are Claude Fable 5. You are connected to Discord...",
    "contextPrefix": null,
    "stopSequences": [
      "\nAlice:",
      "\nClaude Fable:",
      "<<HUMAN_CONVERSATION_END>>"
    ]
  }
}
```

**Response fields:**
- `messages[].participant` — name as it appears in the LLM prompt (after display-name resolution, character overrides, etc.)
- `messages[].content` — text content joined with newlines (images noted separately)
- `messages[].hasImages` / `imageCount` — image attachments not included in `content`
- `metadata.discordMessagesFetched` — raw count returned by Discord (always ≥ `messageCount` since merging/filtering reduces)
- `metadata.configuredLimit` — what the bot's YAML config says (independent of the `messages` parameter)
- `metadata.requestedLimit` — the `messages` value from the request, or `null` if defaulted
- `metadata.systemPrompt` / `contextPrefix` — first 200 chars only, with ellipsis if longer
- `metadata.stopSequences` — exact stop sequences this request would send to the LLM

**Errors:**
- 400 — missing `channel`, invalid URL/ID format
- 403 — bot lacks access to channel
- 404 — channel not found, or empty channel
- 501 — API server lacks the context builder (Bridge is configured for it; other API-enabled bots may not be)

**Example:**
```bash
curl -X POST http://localhost:3306/api/context/build \
  -H "Authorization: Bearer $(cat api_token)" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "https://discord.com/channels/1391260973872185424/1398036481146355803",
    "messages": 500
  }'
```

**Notes:**
- Returns the prompt as Bridge would assemble it. Bots with different system prompts or steering still produce different prompts at activation time — use the bot whose context you want.
- No LLM call is made; this is read-only.
- Tool cache is empty in the returned context (the bot's actual activations interleave tool history; this endpoint is for prompt inspection, not replay).

---

### Get User Info
```http
GET /api/users/:userId?guildId=GUILD_ID
```

Get information about a Discord user, optionally with server-specific details.

**Authentication:** Bearer token required

**Parameters:**
- `userId` (path, required): Discord user ID
- `guildId` (query, optional): Guild ID for server-specific display name and roles

**Response:**
```json
{
  "id": "1030846477418909696",
  "username": "q_m_o",
  "displayName": "Egr. Catalyst",
  "discriminator": "0",
  "bot": false,
  "avatarUrl": "https://cdn.discordapp.com/avatars/.../....webp?size=128",
  "roles": ["mod", "alpha tester", "bot orchestrator"]
}
```

**Notes:**
- Without `guildId`: Returns username as displayName, no roles field
- With `guildId`: Returns server-specific nickname and role list
- `roles` array excludes @everyone

**Example:**
```bash
# Global user info
curl "http://localhost:3000/api/users/1030846477418909696" \
  -H "Authorization: Bearer your-token-here"

# Server-specific info
curl "http://localhost:3000/api/users/1030846477418909696?guildId=1052321771216457748" \
  -H "Authorization: Bearer your-token-here"
```

---

### Get User Avatar
```http
GET /api/users/:userId/avatar?size=SIZE
```

Get CDN URL for a user's avatar image.

**Authentication:** Bearer token required

**Parameters:**
- `userId` (path, required): Discord user ID
- `size` (query, optional): Avatar size in pixels (128, 256, 512, 1024)
  - Default: 128

**Response:**
```json
{
  "avatarUrl": "https://cdn.discordapp.com/avatars/USER_ID/HASH.png?size=256"
}
```

**Example:**
```bash
curl "http://localhost:3000/api/users/1030846477418909696/avatar?size=256" \
  -H "Authorization: Bearer your-token-here"
```

---

## Example Usage

### Python
```python
import requests

# Export messages
response = requests.post(
    'http://localhost:3000/api/messages/export',
    headers={'Authorization': 'Bearer your-token-here'},
    json={
        'last': 'https://discord.com/channels/123/456/789',
        'recencyWindow': {'messages': 400}
    }
)

data = response.json()
for msg in data['messages']:
    print(f"{msg['author']['displayName']}: {msg['content']}")

# Get user info
user_id = data['messages'][0]['author']['id']
user_info = requests.get(
    f'http://localhost:3000/api/users/{user_id}?guildId=123',
    headers={'Authorization': 'Bearer your-token-here'}
).json()

print(f"User: {user_info['displayName']}")
print(f"Roles: {', '.join(user_info['roles'])}")
```

### curl
```bash
# Export messages
curl -X POST http://localhost:3000/api/messages/export \
  -H "Authorization: Bearer $(cat api_token)" \
  -H "Content-Type: application/json" \
  -d '{
    "last": "https://discord.com/channels/123/456/789",
    "first": "https://discord.com/channels/123/456/700",
    "recencyWindow": {"messages": 400}
  }'

# Get user info
curl "http://localhost:3000/api/users/1030846477418909696?guildId=123" \
  -H "Authorization: Bearer $(cat api_token)"

# Get avatar
curl "http://localhost:3000/api/users/1030846477418909696/avatar?size=512" \
  -H "Authorization: Bearer $(cat api_token)"
```

## Use Cases

1. **Live prompt inspection** - `/api/context/build` returns what the bot would send to the LLM right now, without making the call. Backs `/get_prompt` and `/get_context` slash commands.
2. **Research Commons Integration** - Export Discord conversations for web archive with full user metadata
3. **Data Analysis** - Extract conversation data with reactions, attachments, and user info
4. **Backup/Archive** - Programmatic conversation backups with complete metadata
5. **User Directory** - Build user profiles with server-specific names, roles, and avatars
6. **Frontend Display** - Get avatar URLs and display names for UI rendering

## API Features Summary

### Message Export
- ✅ **Unified `.history` support** - Same traversal logic as bot
- ✅ **Reactions included** - Emoji and count for each reaction
- ✅ **Attachments with base64** - Full metadata (URL, filename, size, type) + base64-encoded image data
- ✅ **Image type detection** - Magic byte detection for accurate MIME types
- ✅ **Reply tracking** - referencedMessageId for threaded conversations
- ✅ **Cross-channel/server** - Works with any Discord URL
- ✅ **Recency limits** - Message count or character limits (default: 50 messages)
- ✅ **Optimized fetching** - Only fetches what's needed based on limits

### Live Context Build
- ✅ **Full pipeline** - Runs the actual bot context builder (config, steering, plugins, merging, recency, cache markers, stop sequences)
- ✅ **Per-bot config** - Pinned configs, system prompt, mode, model all match the running bot
- ✅ **No character cap** - `recency_window_characters` / `hard_max_characters` forced to `Infinity`; `messages` is the only cap
- ✅ **Read-only** - No LLM call made

### User Information
- ✅ **Global user info** - Username, discriminator, bot flag
- ✅ **Server-specific** - Display name and roles per guild
- ✅ **Avatar URLs** - CDN links with configurable size
- ✅ **Space for mapping** - Future author aliasing support

## Error Handling

The API returns appropriate HTTP status codes with detailed error messages:

### Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | Success | Request completed successfully |
| 400 | Bad Request | Invalid URL format, missing parameters |
| 401 | Unauthorized | Missing authorization header |
| 403 | Forbidden | Invalid bearer token |
| 404 | Not Found | User/channel/message not found |
| 500 | Server Error | Unexpected server error |

### Error Response Format

```json
{
  "error": "Not Found",
  "message": "Channel 123456789 not found or bot is not a member of this guild",
  "details": "The bot cannot access this channel/message. Check bot permissions."
}
```

### Common Errors

**Invalid URL Format** (400)
```json
{
  "error": "Bad Request",
  "message": "Invalid Discord message URL format",
  "details": "Expected format: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID"
}
```

**Channel Not Accessible** (403/404)
```json
{
  "error": "Forbidden",
  "message": "Missing Access: Bot does not have permission to view channel 123456789",
  "details": "The bot does not have permission to access this channel."
}
```

**Message Not Found** (404)
```json
{
  "error": "Not Found",
  "message": "Unknown Message: Message 123456789 not found in channel 987654321",
  "details": "The bot cannot access this channel/message. Check bot permissions."
}
```

**User Not Found** (404)
```json
{
  "error": "Not Found",
  "message": "User 123456789 not found",
  "details": "The user may not exist or the bot cannot see them."
}
```

**Invalid Authentication** (401/403)
```json
{
  "error": "Invalid bearer token"
}
```

## Security

- ✅ Bearer token authentication (all endpoints except `/health`)
- ✅ Bot must have access to requested channels
- ✅ Respects Discord permissions (bot's view of channel)
- ✅ Detailed error messages for debugging
- ⚠️ Keep `api_token` file secure
- ⚠️ Consider rate limiting for production use

## Future: Author Mapping

Space reserved for mapping Discord users to participant aliases:

```json
{
  "author": {
    "id": "123",
    "username": "alice",
    "displayName": "Alice",
    "mappedParticipant": "Researcher_A"  // Future feature
  }
}
```

Configuration will be added to allow anonymization/aliasing for research/export purposes.

