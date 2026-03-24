# agent-discord

An **MCP (Model Context Protocol) server** that lets any MCP-capable agent — such as [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — communicate with Discord through a bot: send messages, read messages, list servers and channels, and wait for replies.

## Features

| MCP Tool | Description |
|---|---|
| `list_guilds` | List every Discord server the bot is in |
| `list_channels` | List all text channels in a guild |
| `send_message` | Send a message to a channel |
| `read_messages` | Read recent messages from the in-memory cache |
| `get_channel_history` | Fetch paginated message history via the Discord API |
| `wait_for_message` | Poll until a matching message arrives (great for command-response flows) |

## Requirements

- **Node.js 18+**
- A **Discord bot token** with the following permissions:
  - Bot scopes: `bot`, `applications.commands`
  - Text permissions: *Send Messages*, *Read Message History*, *View Channels*
  - **Privileged Gateway Intents**: *Message Content Intent* (required to read message bodies)

## Setup

### 1 — Create a Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Navigate to **Bot** → **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Copy the **Bot Token** (keep it secret).
5. Under **OAuth2 → URL Generator**, select scopes `bot` and permissions *Send Messages + Read Message History + View Channels*.
6. Open the generated URL and invite the bot to your server.

### 2 — Configure the server

```bash
git clone https://github.com/anthony-maio/agent-discord.git
cd agent-discord
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_GUILD_ID=your-default-server-id   # optional
MESSAGE_CACHE_SIZE=100                      # optional
```

### 3 — Build

```bash
npm run build
```

### 4 — Wire into an MCP-capable agent

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/agent-discord/dist/index.js"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token-here",
        "DISCORD_GUILD_ID": "your-server-id"
      }
    }
  }
}
```

#### Claude Code (via CLI)

```bash
claude mcp add discord -- node /absolute/path/to/agent-discord/dist/index.js
```

Then set the env vars in your shell or in Claude Code's config.

#### Run directly (for testing)

```bash
npm start
# or during development
npm run dev
```

## MCP Tool Reference

### `list_guilds`

Returns all Discord servers the bot is a member of.

```json
// No input required
```

### `list_channels`

```json
{
  "guild_id": "123456789012345678"   // optional if DISCORD_GUILD_ID is set
}
```

### `send_message`

```json
{
  "channel_id": "987654321098765432",
  "message": "Hello from the agent!"
}
```

Returns `{ "message_id": "...", "timestamp": "..." }`.

### `read_messages`

```json
{
  "channel_id": "987654321098765432",  // optional filter
  "limit": 20                          // 1–100, default 20
}
```

Returns an array of messages from the in-process cache.

### `get_channel_history`

```json
{
  "channel_id": "987654321098765432",
  "limit": 50,         // 1–100, default 50
  "before": "...",     // message ID for pagination (optional)
  "after": "..."       // message ID for pagination (optional)
}
```

### `wait_for_message`

```json
{
  "channel_id": "987654321098765432",
  "keyword": "approve",         // optional substring filter
  "timeout_seconds": 60,        // 1–300, default 60
  "after_message_id": "..."     // only see messages newer than this ID
}
```

Returns the matching message or `{ "timed_out": true }`.

## Use case: Claude Code command-and-control

1. A human operator opens a Discord channel (e.g. `#claude-code`).
2. Claude Code is given access to this MCP server.
3. Claude Code sends a progress update via `send_message`, then calls `wait_for_message` to block until the operator types `approve` or `reject` before proceeding with a destructive action.
4. All activity is logged in Discord, giving the team a persistent audit trail.

## Development

```bash
# Run tests (no live Discord connection required)
npm test

# TypeScript watch mode
npx tsc --watch

# Dev mode (tsx hot-reload)
npm run dev
```

## License

ISC
