# halobot

**Human-Agent Loop Over Bot** — an MCP server that gives any AI agent a Discord communication channel, from low-level message access to high-level, thread-based human-in-the-loop conversations.

**Why does this exist?** Claude Code has dispatch. Cursor has its own notification system. Every AI tool reinvents "talk to the human." This is the MCP answer: one Discord server, any agent, zero vendor lock-in.

## How It Works

```
┌─────────────┐     STDIO/MCP      ┌──────────────────┐     Discord API    ┌─────────────┐
│  Any Agent   │◄──────────────────►│    halobot       │◄──────────────────►│   Discord    │
│ (Claude Code,│                    │   MCP Server     │   create thread    │   Server     │
│  Cursor,     │  11 MCP tools      │                  │   post message     │              │
│  custom)     │                    │   Discord Bot    │   wait for reply   │  👤 You      │
└─────────────┘                     └──────────────────┘                    └─────────────┘
```

### Thread-Based Conversations (Recommended)

1. Agent calls `send_thread_message` — bot creates a thread, pings you
2. You reply in the thread
3. Agent calls `wait_for_reply` to get your response
4. Long messages automatically chunk across multiple Discord messages

### Low-Level Access

Agents can also directly list guilds/channels, send raw messages, read cache, fetch history, and poll for keyword matches — useful for monitoring, logging, or custom flows.

## MCP Tools

### High-Level (Thread Conversations)

| Tool | Description |
|------|-------------|
| `send_thread_message` | Send a message to a whitelisted user via a thread. Creates a new thread or posts in an existing one. |
| `wait_for_reply` | Poll a thread for the human's reply (configurable timeout). |
| `send_and_wait` | Send + wait in one call. Best for simple Q&A exchanges. |
| `list_conversations` | List all active thread conversations. |
| `get_thread_messages` | Fetch full message history from a thread. |

### Low-Level (Raw Discord)

| Tool | Description |
|------|-------------|
| `list_guilds` | List all servers the bot is in. |
| `list_channels` | List text channels in a guild. |
| `send_message` | Send a message to any channel. |
| `read_messages` | Read recent messages from the in-memory cache. |
| `get_channel_history` | Fetch paginated message history via API. |
| `wait_for_message` | Poll until a matching message arrives (keyword filter). |

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Navigate to **Bot** → create bot
3. Enable **Privileged Gateway Intents**:
   - Message Content Intent
   - Server Members Intent (optional but recommended)
4. Copy the bot token
5. Generate an invite URL (OAuth2 → URL Generator) with permissions:
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Read Message History
   - Manage Threads
   - View Channels
6. Invite the bot to your server

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_GUILD_ID=your-server-id          # For list_channels default
DISCORD_CHANNEL_ID=your-channel-id       # Where threads get created
DISCORD_ALLOWED_USERS=your-user-id       # Comma-separated for multiple
REPLY_TIMEOUT_SECONDS=300                 # 5 min default
POLL_INTERVAL_MS=2000                     # How often to check for replies
```

**Finding IDs:** Enable Developer Mode in Discord settings → right-click channel/user → Copy ID.

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Configure Your MCP Client

#### Claude Code (CLI)

```bash
claude mcp add discord -- node /absolute/path/to/halobot/dist/index.js
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/halobot/dist/index.js"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-token",
        "DISCORD_GUILD_ID": "your-server-id",
        "DISCORD_CHANNEL_ID": "your-channel-id",
        "DISCORD_ALLOWED_USERS": "your-user-id"
      }
    }
  }
}
```

#### Any STDIO MCP Client

```bash
node dist/index.js
```

## Usage Examples

**Agent asks a question and waits for your answer:**
```
→ send_and_wait(content="I found 3 approaches for the auth refactor. Want me to list them?")
← { "status": "replied", "thread_id": "123", "reply": "Yeah, show me all three" }
```

**Agent sends a status update in an ongoing conversation:**
```
→ send_thread_message(content="Finished refactoring auth. 47 tests pass.", thread_id="123")
← { "status": "sent", "thread_id": "123" }
```

**Agent checks conversation history:**
```
→ get_thread_messages(thread_id="123", limit=20)
← { "messages": [{ "author": "Agent", "content": "...", ... }, ...] }
```

**Agent monitors a channel for approvals (low-level):**
```
→ send_message(channel_id="456", message="Deploy to prod? Reply 'approve' to confirm.")
← { "message_id": "789" }
→ wait_for_message(channel_id="456", keyword="approve", after_message_id="789", timeout_seconds=120)
← { "content": "approve", ... }
```

## Security

- **Whitelist enforcement.** Thread-based tools only allow users in `DISCORD_ALLOWED_USERS`.
- **Thread isolation.** Each agent conversation gets its own thread.
- **No inbound commands.** The bot doesn't accept arbitrary commands from Discord.
- **Logs to stderr.** MCP protocol uses stdout; all logging goes to stderr.
- **Low-level tools are unrestricted** — they access any channel the bot can see. Use thread-based tools for controlled human-in-the-loop flows.

## Architecture

The server runs two things concurrently:

1. **Discord bot** (discord.js) — connects to Discord, manages threads, caches messages
2. **MCP server** (@modelcontextprotocol/sdk) — listens on STDIO for tool calls

The Discord client logs in immediately on startup. MCP tools wait for the client to be ready before executing. Messages longer than Discord's 2000-char limit are automatically chunked at newline boundaries.

## Development

```bash
# Run tests (no live Discord connection required)
npm test

# Dev mode with hot-reload
npm run dev

# TypeScript watch
npx tsc --watch
```

## Future Ideas

- [ ] SSE transport for remote/multi-agent access
- [ ] File/image attachment support via threads
- [ ] Reaction-based quick responses (👍 = yes, 👎 = no)
- [ ] Persistent conversation state across server restarts
- [ ] Rate limiting per agent
- [ ] Webhook mode for push-based replies (no polling)

## License

ISC
