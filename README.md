<div align="center">

# halobot

**Your AI agent needs a phone number. Discord is it.**

[![npm version](https://img.shields.io/npm/v/@anthony-maio/halobot)](https://www.npmjs.com/package/@anthony-maio/halobot)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![MCP Tools](https://img.shields.io/badge/MCP_Tools-11-orange)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-99.4%25-blue)]()

An open-source MCP server that gives any AI agent a Discord communication channel.
Agents ask questions, wait for your reply, and keep working -- from your phone, desktop, wherever.

**H**uman-**A**gent **L**oop **O**ver **B**ot

[Documentation](https://halobot.making-minds.ai) . [Quickstart](https://halobot.making-minds.ai/#quickstart) . [GitHub](https://github.com/anthony-maio/halobot)

</div>

---

## The problem

Your agent is three hours into a refactoring task. It hits an ambiguous requirement. It guesses. It picks the wrong interpretation. It builds 400 lines on a bad assumption. You come back, see the mess, and start over.

Claude Code has dispatch. Cursor has its own notification system. Every AI tool reinvents "talk to the human."

halobot is the MCP answer: **one Discord server, any agent, zero vendor lock-in.**

| Without halobot | With halobot |
|---|---|
| Agent guesses at ambiguous requirements | Agent asks, you answer, work continues |
| You discover mistakes hours later | Respond from your phone, desktop, wherever |
| No way to reach you outside the IDE | Works with any MCP client |
| Each tool builds its own notification system | One protocol, every agent |
| 3 AM deploys you didn't approve | Explicit approval gates for critical ops |

## Quick start

```bash
# Install globally
npm install -g @anthony-maio/halobot

# Interactive setup -- walks you through everything
halobot setup
```

That's it. The setup wizard links you to the Discord Developer Portal, generates the invite URL, collects your IDs, validates everything, and optionally configures Claude Code automatically.

```bash
# Check your setup
halobot doctor

# Check setup and send a test message
halobot doctor --test
```

## How it works

```
+--------------+  STDIO/MCP  +------------------+  Discord API  +--------------+
|  Any Agent   |<------------>|     halobot      |<------------->|   Discord    |
| (Claude Code,|             |   MCP Server     | create thread |   Server     |
|  Cursor,     |  11 MCP     |                  | post message  |              |
|  Codex,      |  tools      |   Discord Bot    | wait for reply|   You        |
|  custom)     |             |                  |               |              |
+--------------+              +------------------+               +--------------+
```

1. Agent calls `send_and_wait` -- bot creates a Discord thread, pings you
2. You reply in the thread (phone, desktop, wherever)
3. Agent gets your response and keeps working
4. Long messages auto-chunk across Discord's 2000-char limit

## MCP tools

### High-level -- Thread conversations

| Tool | What it does |
|---|---|
| `send_thread_message` | Send a message via a Discord thread. Creates new or continues existing. |
| `wait_for_reply` | Poll a thread for the human's reply (configurable timeout). |
| `send_and_wait` | Send + wait in one call. Best for simple Q&A. |
| `list_conversations` | List all active thread conversations. |
| `get_thread_messages` | Fetch full message history from a thread. |

### Low-level -- Raw Discord access

| Tool | What it does |
|---|---|
| `list_guilds` | List all servers the bot is in. |
| `list_channels` | List text channels in a guild. |
| `send_message` | Send a message to any channel. |
| `read_messages` | Read recent messages from the in-memory cache. |
| `get_channel_history` | Fetch paginated message history via API. |
| `wait_for_message` | Poll until a matching message arrives (keyword filter). |

## Use cases

**Decision points** -- Agent hits an ambiguous requirement, asks which approach. You reply "option 2" from your phone.

**Approval gates** -- Agent reaches a deploy step, waits for your explicit "go" before continuing. No more 3 AM deploys.

**Progress updates** -- Agent posts status to the thread as it works. You check in when convenient.

**Multi-agent coordination** -- Multiple agents, each with their own thread, all reaching the same human. You're the hub.

**Collaborative debugging** -- Agent posts what it tried, asks for your intuition, tries again. Async pair programming.

## Configuration

### Claude Code (CLI)

```bash
claude mcp add halobot \
  -e DISCORD_BOT_TOKEN=your-token \
  -e DISCORD_CHANNEL_ID=your-channel-id \
  -e DISCORD_ALLOWED_USERS=your-user-id \
  -- halobot
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "halobot": {
      "command": "halobot",
      "env": {
        "DISCORD_BOT_TOKEN": "your-token",
        "DISCORD_CHANNEL_ID": "your-channel-id",
        "DISCORD_ALLOWED_USERS": "your-user-id"
      }
    }
  }
}
```

### Any MCP client

halobot speaks standard MCP over STDIO. If your client supports MCP, it supports halobot.

**Finding IDs:** Enable Developer Mode in Discord settings -> right-click channel/user -> Copy ID.

## Security

- **Whitelist enforcement.** Thread-based tools only respond to users in `DISCORD_ALLOWED_USERS`.
- **Thread isolation.** Each agent conversation gets its own thread. No cross-talk.
- **No inbound commands.** The bot doesn't accept arbitrary commands from Discord.
- **Low-level tools are unrestricted** -- they access any channel the bot can see. Use thread-based tools for controlled flows.

## Development

```bash
# Run tests (no live Discord connection required)
npm test

# Dev mode with hot-reload
npm run dev

# TypeScript watch
npx tsc --watch
```

## Roadmap

- [ ] SSE transport for remote/multi-agent access
- [ ] File/image attachment support via threads
- [ ] Reaction-based quick responses
- [ ] Persistent conversation state across server restarts
- [ ] Rate limiting per agent
- [ ] Webhook mode for push-based replies (no polling)

## License

ISC

---

<div align="center">

**[halobot.making-minds.ai](https://halobot.making-minds.ai)**

Built by [Anthony Maio](https://github.com/anthony-maio)

</div>
