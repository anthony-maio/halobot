# Halobot Website Brief

## What is halobot?

Halobot (Human-Agent Loop Over Bot) is an open-source MCP server that gives AI agents a Discord communication channel. Any MCP-capable agent (Claude Code, Claude Desktop, Cursor, etc.) can use it to send messages to humans via Discord threads and wait for replies — enabling human-in-the-loop workflows without vendor lock-in.

## Key message

"Your AI agent needs a phone number. Discord is it."

AI agents are great at working autonomously, but they're terrible at asking you a question and waiting for an answer. Halobot fixes that with one MCP server, any agent, and the Discord app you already have on your phone.

## Links

- **GitHub repo:** https://github.com/anthony-maio/halobot
- **npm package:** https://www.npmjs.com/package/@anthony-maio/halobot
- **Author:** Anthony Maio — https://github.com/anthony-maio

## Core features to highlight

1. **Thread-based conversations** — each agent interaction gets its own Discord thread. Clean, organized, no cross-talk between agents.
2. **Works with any MCP client** — Claude Code, Claude Desktop, Cursor, or any tool that speaks the Model Context Protocol.
3. **Human-in-the-loop** — agents ask questions, wait for your reply, and continue working. You respond from your phone, desktop, wherever.
4. **One-command setup** — `npx halobot setup` walks you through everything interactively with clickable links.
5. **Built-in diagnostics** — `halobot doctor` validates your entire setup before you use it.
6. **User whitelisting** — only approved Discord users can interact with agent threads.
7. **Auto-chunking** — long messages split automatically across Discord's 2000-char limit.
8. **11 MCP tools** — 5 high-level (thread conversations) + 6 low-level (raw Discord access).

## How it works (diagram content)

```
Agent (Claude Code, Cursor, etc.)
  ↕ MCP protocol (STDIO)
halobot MCP Server
  ↕ Discord API
Discord Server → threads → human replies on phone/desktop
```

## Quick start content

```bash
# Install
npm install -g @anthony-maio/halobot

# Interactive setup (creates bot, validates, configures Claude Code)
npx halobot setup

# Or add manually to Claude Code
claude mcp add discord -- halobot

# Diagnose issues
halobot doctor
```

## Use case examples for the page

- **Decision points:** Agent hits an ambiguous requirement, asks you which approach to take, you reply "option 2" from your phone
- **Approval gates:** Agent reaches a deployment step, waits for your explicit "go" in Discord before continuing
- **Progress updates:** Agent posts status to the thread as it works, you check in when convenient
- **Multi-agent coordination:** Multiple agents, each with their own thread, all reaching the same human

## Tool reference (for a docs section)

### High-level (thread conversations)

| Tool | What it does |
|------|-------------|
| `send_thread_message` | Send a message via a Discord thread (creates new or continues existing) |
| `wait_for_reply` | Wait for the human to reply in a thread |
| `send_and_wait` | Send + wait in one call (best for simple Q&A) |
| `list_conversations` | List all active thread conversations |
| `get_thread_messages` | Fetch full message history from a thread |

### Low-level (raw Discord)

| Tool | What it does |
|------|-------------|
| `list_guilds` | List all servers the bot is in |
| `list_channels` | List text channels in a guild |
| `send_message` | Send a message to any channel |
| `read_messages` | Read recent messages from the in-memory cache |
| `get_channel_history` | Fetch paginated message history via API |
| `wait_for_message` | Poll until a matching message arrives |

## Design notes

- Keep it simple and single-page like the cartograph reference site
- Dark theme preferred (developer audience)
- The "HALO" backronym (Human-Agent Loop Over Bot) is a good visual element
- GitHub star button / link prominent
- npm install command should be copy-pasteable
- Mobile-friendly (ironic given the product is about reaching devs on mobile)

## Content from the introductory article

A full 1500-word article is available at `docs/introducing-halobot.md` in the repo — can be adapted for longer-form content on the site or a blog section.
