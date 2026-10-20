# Production Deployment Guide

This guide covers deploying Chapter3 bots to production, including the trace viewer.

## Directory Structure

Recommended production layout (compatible with chapter2):

```
/opt/chapterx/                    # Main installation
├── config/
│   ├── shared.yaml              # Shared vendor configs (API keys)
│   └── bots/
│       ├── BotName1.yaml        # Per-bot configurations
│       └── BotName2.yaml
├── logs/
│   ├── traces/                  # Activation traces
│   │   ├── BotName1/           # Per-bot trace directories
│   │   └── BotName2/
│   │   └── index.jsonl         # Shared trace index
│   ├── llm-requests/           # LLM request bodies, image, audio and document data replaced by its length
│   └── llm-responses/          # Full LLM response bodies
├── cache/                       # Persistent cache
│   └── plugins/                # Plugin state
├── src/
├── dist/
├── node_modules/
├── discord_token               # Default Discord token
└── package.json
```

## Environment Variables

### Bot Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_CONFIG` | Path to bot config file | Auto-detected |
| `DISCORD_TOKEN_FILE` | Path to Discord token file | `./discord_token` |
| `CACHE_PATH` | Cache directory | `./cache` |
| `CONFIG_PATH` | Config directory | `./config` |
| `LOGS_DIR` | Logs directory | `./logs` |
| `TRACE_DIR` | Trace files directory | `./logs/traces` |

### Trace Viewer

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3847` |
| `AUTH_TOKEN` | Bearer token for authentication | (none - no auth) |
| `LOGS_DIR` | Base logs directory | `./logs` |

## Running a Single Bot

```bash
# From /opt/chapterx
npm run start -- --config ./config/bots/MyBot.yaml

# Or with environment variables
DISCORD_TOKEN_FILE=./tokens/mybot_token \
CACHE_PATH=./cache/mybot \
npm run start -- --config ./config/bots/MyBot.yaml
```

## Running Multiple Bots

Each bot needs its own:
- Discord token
- Cache directory  
- Bot config file

### Using Screen Sessions

```bash
# Start bot 1
screen -dmS bot1 bash -c 'cd /opt/chapterx && npm run start -- --config ./config/bots/Bot1.yaml'

# Start bot 2
screen -dmS bot2 bash -c 'cd /opt/chapterx && \
  DISCORD_TOKEN_FILE=./tokens/bot2_token \
  CACHE_PATH=./cache/bot2 \
  npm run start -- --config ./config/bots/Bot2.yaml'

# List screens
screen -ls

# Attach to a screen
screen -r bot1
```

### Using Systemd (Recommended)

Create `/etc/systemd/system/chapterx-botname.service`:

```ini
[Unit]
Description=Chapter3 Bot - BotName
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/chapterx
Environment=NODE_ENV=production
Environment=DISCORD_TOKEN_FILE=/opt/chapterx/tokens/botname_token
Environment=CACHE_PATH=/opt/chapterx/cache/botname
Environment=LOGS_DIR=/opt/chapterx/logs
ExecStart=/usr/bin/node dist/main.js --config ./config/bots/BotName.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable chapterx-botname
sudo systemctl start chapterx-botname

# View logs
journalctl -u chapterx-botname -f
```

## Trace Viewer

### Running the Trace Viewer

```bash
# Development (no auth)
cd /opt/chapterx
npx tsx tools/trace-server.ts

# Production with auth
AUTH_TOKEN=your-secret-token \
PORT=3847 \
LOGS_DIR=/opt/chapterx/logs \
npx tsx tools/trace-server.ts
```

### Systemd Service for Trace Viewer

Create `/etc/systemd/system/chapterx-traces.service`:

```ini
[Unit]
Description=Chapter3 Trace Viewer
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/chapterx
Environment=NODE_ENV=production
Environment=AUTH_TOKEN=your-secret-token
Environment=PORT=3847
Environment=LOGS_DIR=/opt/chapterx/logs
ExecStart=/usr/bin/npx tsx tools/trace-server.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Nginx Reverse Proxy

For public access with HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name traces.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Shared Configuration

### Vendor Config (shared.yaml)

```yaml
providers:
  anthropic:
    api_key: sk-ant-api03-xxx
    
  openai:
    api_key: sk-xxx
    
  openrouter:
    api_key: sk-or-xxx
    api_base: https://openrouter.ai/api/v1
```

### Bot Config Example

```yaml
name: MyBot  # Name used in LLM context

# Use shared provider
providers_config: ../shared.yaml  # Relative to this config file

mode: prefill
prefill_thinking: true
continuation_model: claude-sonnet-4-5-20250929
temperature: 1.0
max_tokens: 4096

tool_plugins: ['config', 'notes']
plugin_config:
  notes:
    state_scope: channel
```

## Updating/Deploying

```bash
cd /opt/chapterx

# Pull latest
git pull origin main

# Install dependencies
npm install

# Build TypeScript
npm run build

# Restart bots
systemctl restart chapterx-bot1 chapterx-bot2

# Or with screens
screen -S bot1 -X stuff $'\003'  # Send Ctrl+C
screen -S bot1 -X stuff 'npm run start -- --config ./config/bots/Bot1.yaml\n'
```

## Monitoring

### View Bot Logs

```bash
# Systemd
journalctl -u chapterx-botname -f --since "1 hour ago"

# Screen
screen -r botname
```

### View Trace Stats

```bash
# Count traces per bot
for d in /opt/chapterx/logs/traces/*/; do
  echo "$(basename $d): $(ls $d/*.json 2>/dev/null | wc -l) traces"
done

# Recent failed traces
grep '"success":false' /opt/chapterx/logs/traces/index.jsonl | tail -10
```

### Disk Usage

```bash
du -sh /opt/chapterx/logs/*
du -sh /opt/chapterx/cache/*
```

## Cleanup

Traces and logs can grow large. Set up periodic cleanup:

```bash
# /etc/cron.daily/chapterx-cleanup
#!/bin/bash

# Remove traces older than 7 days
find /opt/chapterx/logs/traces -name "*.json" -mtime +7 -delete

# Remove old LLM request/response bodies
find /opt/chapterx/logs/llm-requests -name "*.json" -mtime +3 -delete
find /opt/chapterx/logs/llm-responses -name "*.json" -mtime +3 -delete

# Rebuild index (removes entries for deleted traces)
# TODO: Add index cleanup script
```

## Integration with Chapter2

Chapter3 can coexist with Chapter2 deployments. The trace viewer supports viewing traces from multiple bot frameworks:

```
/opt/
├── chapter2/
│   └── ems/
│       ├── config.yaml        # Chapter2 shared config
│       ├── bot1/
│       │   ├── config.yaml
│       │   └── discord_token
│       └── logs/
└── chapterx/
    ├── config/
    │   └── bots/
    └── logs/
        └── traces/
```

The trace viewer at `/opt/chapterx/tools/trace-server.ts` automatically discovers bot directories under `logs/traces/`.

