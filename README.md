# ChapterX - Discord Bot Framework

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
name: Claude  # Name used in LLM context

mode: prefill
continuation_model: claude-3-5-sonnet-20241022
temperature: 1.0
max_tokens: 4096

recency_window_messages: 400  # Optional: max messages
recency_window_characters: 100000  # Optional: max characters
rolling_threshold: 50

include_images: true
max_images: 5

tools_enabled: true
tool_output_visible: false
```

### 4. Configure Vendor

Create `config/shared.yaml`:

**Anthropic:**
```yaml
vendors:
  anthropic:
    config:
      anthropic_api_key: "sk-ant-..."
    provides:
      - "claude-3-5-sonnet-*"
      - "claude-3-opus-*"
      - "claude-sonnet-4-*"
```

**OpenAI (or compatible API):**
```yaml
vendors:
  openai:
    config:
      openai_api_key: "sk-..."
      openai_base_url: "https://api.openai.com/v1"  # Optional, for compatible APIs
    provides:
      - "gpt-4o*"
      - "gpt-4-turbo*"
      - "gpt-3.5-turbo*"
```

**Notes on OpenAI provider:**
- Only supports `mode: chat` (not prefill - OpenAI doesn't allow partial assistant messages)
- Images not yet supported (different format from Anthropic)
- For prefill support with OpenAI-compatible APIs, additional providers needed (OpenRouter, completions API)

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
- [Plugins](./docs/plugins.md) - Plugin system documentation
- [Deployment](./docs/deployment.md) - Production deployment guide

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
name: BotName  # Name used in LLM context (prefill labels, stop sequences)

# Model
mode: prefill  # or 'chat'
continuation_model: claude-3-5-sonnet-20241022
temperature: 1.0
max_tokens: 4096
top_p: 1.0

# Context
recency_window_messages: 400  # Optional: max messages
recency_window_characters: 100000  # Optional: max characters
# When both specified, whichever limit is reached first is used
rolling_threshold: 50

# Images
include_images: true
max_images: 5

# Tools
tools_enabled: true
tool_output_visible: false
max_tool_depth: 100

# Retry
llm_retries: 3
discord_backoff_max: 32000

# Misc
system_prompt: "Optional system prompt"
reply_on_random: 0
reply_on_name: false
max_queued_replies: 1
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
max_tokens: 2000
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

## Updating Dependencies

### Membrane (LLM Abstraction Layer)

ChapterX uses [membrane](https://github.com/antra-tess/membrane) as its LLM abstraction layer. Membrane is installed as a git dependency and won't auto-update with regular `npm install`.

**To update membrane to the latest version:**

```bash
npm update membrane
```

This will fetch the latest commit from the `main` branch and update your `package-lock.json`.

> **Note:** After updating, you should commit the updated `package-lock.json` to keep your deployment in sync. A future release of membrane will be published to npm for easier version management.

**Check current vs latest version:**

```bash
# See what you have installed
npm ls membrane

# See latest on GitHub
git ls-remote https://github.com/antra-tess/membrane.git refs/heads/main | cut -c1-7
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

## Acknowledgements

ChapterX is developed to be compatible and interoperable with the [chapter2](https://github.com/joysatisficer/chapter2). Many critical concepts, including the use of Discord as the single source of truth, supporting real-time configuration via pinned Discord messages and other, have been pioneered in chapter2 by [Janus](https://x.com/repligate) and [ampdot](https://x.com/amplifiedamp)/[joysatisficer](https://x.com/joysatisficer).


## License

MIT

