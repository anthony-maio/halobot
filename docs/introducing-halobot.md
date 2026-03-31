# Your AI Agent Needs a Phone Number. Discord Is It.

AI agents are getting good at writing code, debugging systems, and making decisions. But they're terrible at one thing: asking you a question and waiting for the answer.

Think about it. Your agent is three hours into a refactoring task. It hits an ambiguous requirement. What does it do? It guesses. It picks the wrong interpretation. It builds 400 lines of code on a bad assumption. You come back, see the mess, and start over.

The missing piece isn't intelligence. It's a communication channel.

## The problem no one talks about

Every AI coding tool has reinvented the same wheel: how to talk to the human. Claude Code has dispatch notifications. Cursor has its own system. Cody, Copilot, Windsurf -- all of them built something proprietary to solve the same problem.

But if you're building your own agent, or using an MCP-capable tool that doesn't have a built-in notification system, you're out of luck. Your agent runs in a terminal. It can't tap you on the shoulder.

And even the tools that do have notifications -- they only work inside that tool. Your agent can't reach you when you're on your phone, eating lunch, or in another app entirely.

## Halobot: Human-Agent Loop Over Bot

Halobot is an MCP server that gives any AI agent a Discord bot. Not a chatbot that responds to commands -- a bot that your agent controls to talk to you.

Here's the flow:

1. Your agent hits a decision point
2. It calls `send_and_wait` with a question
3. A Discord thread appears, pinging you
4. You reply on your phone, your desktop, wherever
5. Your agent gets the answer and continues working

That's it. One tool call. The agent asks, you answer, work continues.

It works with Claude Code, Claude Desktop, Cursor, or any tool that speaks the Model Context Protocol. The agent doesn't know or care that Discord is involved. It just calls an MCP tool and gets a response.

## Why Discord?

You could build this on Slack, Teams, email, SMS. But Discord hits a sweet spot:

**It's already on your phone.** Most developers have Discord installed. No new app to download, no new notification channel to monitor. Your agent's messages show up alongside everything else you already check.

**Threads keep things organized.** Each agent conversation gets its own thread. If you have three agents running -- one refactoring auth, one writing tests, one deploying -- each gets a separate thread. No cross-talk, no confusion.

**It's free.** Discord bots cost nothing to run. No Twilio fees, no Slack Enterprise license, no per-message pricing.

**It works everywhere.** Desktop, mobile, web. Push notifications on all of them. Your agent can reach you wherever you are.

## What it actually looks like

When your agent needs your input, you get a Discord notification like any other message. You open it and see a thread:

> **Agent:** I found 3 approaches for the auth refactor:
> 1. JWT with refresh tokens
> 2. Session-based with Redis
> 3. OAuth2 with provider delegation
>
> Which approach do you want me to go with?

You type "2" on your phone. Your agent picks it up and keeps working.

Long messages -- like code diffs or error logs -- automatically split across multiple Discord messages so nothing gets truncated. The agent can check conversation history to review what was discussed earlier. And a whitelist ensures only approved users can interact with the bot, so random Discord members can't hijack your agent's workflow.

## Beyond question-and-answer

The thread model isn't just for asking questions. Some patterns that work well:

**Progress updates.** Agent posts status to the thread as it works. You check in when you want to, not when the agent demands it.

**Approval gates.** Agent reaches a deployment step and waits for your explicit "go" before continuing. No more 3 AM deploys you didn't approve.

**Collaborative debugging.** Agent posts what it's tried, asks for your intuition, incorporates your response, tries again. Like pair programming, but async.

**Multi-agent coordination.** Multiple agents, each with their own thread, all reaching the same human for decisions. You're the hub, Discord is the switchboard.

## How to set it up

Setup takes about five minutes:

1. Create a Discord bot in the developer portal
2. Invite it to your server
3. Install halobot: `npm install -g @anthony-maio/halobot`
4. Add it to your MCP client (one command for Claude Code)
5. Set three environment variables: bot token, channel ID, your user ID

That's the full setup. No databases, no cloud services, no Docker. It's a single Node.js process that runs alongside your agent.

For Claude Code users:

```bash
claude mcp add discord -- halobot
```

For Claude Desktop, add it to your config file. For anything else that speaks MCP, point it at the `halobot` binary.

## The MCP advantage

This could have been built as a standalone service. But building it as an MCP server means something important: any agent that supports MCP can use it without modification.

Today that's Claude Code, Claude Desktop, Cursor, and a growing list of tools. Tomorrow it'll be whatever new agent framework appears. The protocol is the interface, not the specific tool.

Your agent doesn't import a Discord library. It doesn't know about WebSocket connections or bot tokens. It calls `send_and_wait` and gets a string back. If you swapped Discord for Slack tomorrow, the agent's code wouldn't change -- only the MCP server would.

## What's next

Halobot solves the "my agent can't talk to me" problem. But there's more to build:

**One-click install.** We're working on getting halobot listed in MCP registries so setup is even simpler.

**A doctor command.** A diagnostic tool that checks your bot token, verifies permissions, confirms the channel exists, and validates your whitelist -- before your agent ever tries to send a message.

**File and image support.** Agents should be able to share screenshots, diffs, and diagrams in threads.

**Reaction-based responses.** Thumbs up for yes, thumbs down for no. Skip the typing for simple approvals.

The goal is simple: make the connection between your agent and you as frictionless as possible. Your agent should be able to ask you anything, from anywhere, and get an answer in seconds.

## Try it

Halobot is open source and available now:

- GitHub: github.com/anthony-maio/halobot
- npm: `npm install -g @anthony-maio/halobot`

Set it up once, and your agents will never have to guess again.
