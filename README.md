# Chapter3 - Discord Bot Framework

A sophisticated Discord chat bot framework with multi-LLM support, MCP tool integration, and advanced context management.

## Features

- **Multi-Participant Context**: Honest representation of Discord conversations
- **Multiple LLM Providers**: Anthropic, AWS Bedrock, OpenAI-compatible, Google Gemini
- **Prefill & Chat Modes**: Full support for both conversation modes
- **MCP Tool Integration**: Native Model Context Protocol support
- **Rolling Context**: Efficient prompt caching with rolling message windows
- **Hierarchical Configuration**: YAML-based config with guild/channel overrides
- **Image Support**: Automatic image caching and vision input
- **Advanced Features**: History commands, m commands, dot messages

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `discord_token` file with your bot token:

```bash
echo "your-discord-bot-token" > discord_token
```

Set environment variables (optional - these have defaults):

```bash
export CONFIG_PATH=./config  # Default: ./config
export TOOLS_PATH=./tools    # Default: ./tools
export CACHE_PATH=./cache    # Default: ./cache
export LOG_LEVEL=info        # Default: info

# Optional: Enable REST API
export API_BEARER_TOKEN=$(openssl rand -hex 32)  # Generate secure token
export API_PORT=3000         # Default: 3000
```

**Note:** The bot name is automatically determined from the Discord bot's username. Config is loaded from `config/bots/{discord-username}.yaml`.

#### Optional: REST API

To enable the REST API, set `API_BEARER_TOKEN`:

```bash
echo "your-secure-api-token" > api_token
export API_BEARER_TOKEN=$(cat api_token)
```

The API will be available at `http://localhost:3000` (or your configured `API_PORT`).

### 3. Create Bot Configuration

Create `config/bots/your-bot-name.yaml`:

```yaml
name: My Bot
innerName: Claude

mode: prefill
continuationModel: claude-3-5-sonnet-20241022
temperature: 1.0
maxTokens: 4096

recencyWindowMessages: 400  # Optional: max messages
recencyWindowCharacters: 100000  # Optional: max characters  
rollingThreshold: 50

includeImages: true
maxImages: 5

toolsEnabled: true
toolOutputVisible: false
```

### 4. Configure Vendor (Anthropic Example)

Create `config/shared.yaml`:

```yaml
vendors:
  anthropic:
    config:
      anthropic_api_key: "sk-ant-..."
    provides:
      - "claude-3-5-sonnet-20241022"
      - "claude-3-opus-20240229"
```

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Documentation

- [Architecture](./architecture.md) - Detailed architecture documentation
- [Requirements](./requirements.md) - Full functional requirements  
- [Implementation Status](./IMPLEMENTATION_STATUS.md) - Current development status
- [Outstanding Items](./OUTSTANDING_ITEMS.md) - Prioritized list of remaining tasks

### Key Components

- **Agent Loop**: Main orchestrator
- **Discord Connector**: Handles all Discord API interactions
- **Context Builder**: Transforms Discord → participant format
- **LLM Middleware**: Transforms participant → provider format
- **Tool System**: MCP integration and JSONL persistence
- **Config System**: Hierarchical YAML configuration

## Configuration

### Bot Configuration

```yaml
# Identity
name: Bot Display Name
innerName: BotName  # Used in LLM context

# Model
mode: prefill  # or 'chat'
continuationModel: claude-3-5-sonnet-20241022
temperature: 1.0
maxTokens: 4096
topP: 1.0

# Context
recencyWindowMessages: 400  # Optional: max messages
recencyWindowCharacters: 100000  # Optional: max characters
# When both specified, whichever limit is reached first is used
rollingThreshold: 50

# Images
includeImages: true
maxImages: 5

# Tools
toolsEnabled: true
toolOutputVisible: false
maxToolDepth: 100

# Retry
llmRetries: 3
discordBackoffMax: 32000

# Misc
systemPrompt: "Optional system prompt"
replyOnRandom: 0
replyOnName: false
maxQueuedReplies: 1
```

### Discord Commands

**History Command** (requires authorized role):
```
.history botname
---
first: https://discord.com/channels/.../message_id
last: https://discord.com/channels/.../message_id
```

**Config Command** (must be pinned):
```
.config botname
---
temperature: 0.7
maxTokens: 2000
```

**M Commands**:
- `m continue` - Activate bot without mention

## Debugging & Tracing

The bot includes a comprehensive tracing system that captures every activation, including Discord context, LLM requests/responses, tool executions, and console logs.

### Trace Web Viewer

Start the local web viewer to browse and search traces:

```bash
./trace serve
# Opens at http://localhost:3847
```

Features:
- **Search by Discord URL**: Paste any Discord message URL to find related traces
- **Full LLM request/response viewer**: See exactly what was sent to the API
- **Context transformation details**: Understand how Discord messages became LLM context
- **Console log filtering**: Filter logs by level (debug, info, warn, error)
- **Token usage & cost info**: Track API usage per activation

### Trace CLI

```bash
# List recent traces
./trace list --limit 10

# Show trace summary
./trace explain <trace-id>

# View full LLM request
./trace request <trace-id>

# View full LLM response  
./trace response <trace-id>

# View console logs
./trace logs <trace-id>
```

### Trace Files

Traces are stored in `logs/traces/` as JSON files with an index at `logs/traces/index.jsonl` for fast lookups.

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build
npm run build

# Lint
npm run lint

# Format
npm run format

# Test
npm test
```

## Requirements

- Node.js 20+
- TypeScript 5.3+
- Discord bot token (in `discord_token` file)
- LLM API keys (Anthropic, OpenAI, etc.) (in config files)

## REST API

If enabled with `API_BEARER_TOKEN`, the bot exposes a REST API for accessing Discord conversation history.

### Endpoints

#### `GET /health`
Health check (no auth required)

```bash
curl http://localhost:3000/health
```

#### `POST /api/messages/export`
Export Discord conversation history

**Authentication:** Bearer token required

**Request Body:**
```json
{
  "last": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "first": "https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID",
  "recencyWindow": {
    "messages": 400,
    "characters": 100000
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:3000/api/messages/export \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"last": "https://discord.com/channels/123/456/789"}'
```

## License

MIT

