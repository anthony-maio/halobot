#!/usr/bin/env node
/**
 * agent-discord: An MCP server that allows any MCP-capable agent to
 * communicate with Discord — send messages, read messages, list guilds and
 * channels, and wait for replies.  Perfect for giving tools like Claude Code
 * a persistent Discord-based command-and-control channel.
 *
 * Required environment variables:
 *   DISCORD_BOT_TOKEN  – your Discord bot token
 *
 * Optional:
 *   DISCORD_GUILD_ID   – default guild (server) ID when not supplied per-call
 *   MESSAGE_CACHE_SIZE – number of incoming messages to buffer (default: 100)
 */

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Collection,
  Message,
  ChannelType,
  Partials,
} from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  process.stderr.write(
    "ERROR: DISCORD_BOT_TOKEN environment variable is required.\n"
  );
  process.exit(1);
}

const DEFAULT_GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";
const MESSAGE_CACHE_SIZE = parseInt(
  process.env.MESSAGE_CACHE_SIZE ?? "100",
  10
);

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

/** Rolling buffer of recently received messages (newest last). */
const messageCache: Message[] = [];

discordClient.on("messageCreate", (message) => {
  messageCache.push(message);
  if (messageCache.length > MESSAGE_CACHE_SIZE) {
    messageCache.shift();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialise a discord.js Message into a plain JSON-serialisable object.
 */
function serializeMessage(msg: Message) {
  return {
    id: msg.id,
    channel_id: msg.channelId,
    guild_id: msg.guildId ?? null,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      bot: msg.author.bot,
    },
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    attachments: [...msg.attachments.values()].map((a) => ({ url: a.url, name: a.name })),
    embeds: msg.embeds.map((e) => ({ title: e.title, description: e.description })),
  };
}

/**
 * Wait up to `timeoutMs` for the Discord client to reach "ready" state.
 */
function waitForReady(timeoutMs = 15_000): Promise<void> {
  if (discordClient.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Discord client did not become ready in time")),
      timeoutMs
    );
    discordClient.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Resolve a TextChannel by ID, throwing a descriptive error if not found
 * or not a text channel.
 */
async function resolveTextChannel(channelId: string): Promise<TextChannel> {
  await waitForReady();
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  if (!(channel instanceof TextChannel)) {
    throw new Error(`Channel ${channelId} is not a text channel`);
  }
  return channel;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "agent-discord",
  version: "1.0.0",
});

// ------------------------------------------------------------------
// Tool: list_guilds
// ------------------------------------------------------------------
server.registerTool(
  "list_guilds",
  {
    title: "List Discord Guilds",
    description:
      "Returns a list of all Discord servers (guilds) the bot is a member of, " +
      "including their IDs and names.",
    inputSchema: {},
  },
  async () => {
    await waitForReady();
    const guilds = await discordClient.guilds.fetch();
    const result = guilds.map((g) => ({ id: g.id, name: g.name }));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: list_channels
// ------------------------------------------------------------------
server.registerTool(
  "list_channels",
  {
    title: "List Discord Channels",
    description:
      "Returns all text channels in a Discord guild (server). " +
      "Useful for discovering which channel_id to use with other tools.",
    inputSchema: {
      guild_id: z
        .string()
        .optional()
        .describe(
          "The Discord guild (server) ID. Falls back to DISCORD_GUILD_ID env var."
        ),
    },
  },
  async ({ guild_id }) => {
    await waitForReady();
    const gid = guild_id ?? DEFAULT_GUILD_ID;
    if (!gid) throw new Error("guild_id is required (or set DISCORD_GUILD_ID)");

    const guild = await discordClient.guilds.fetch(gid);
    const channels = await guild.channels.fetch();

    const result = channels
      .filter(
        (c) =>
          c !== null &&
          (c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement)
      )
      .map((c) => ({ id: c!.id, name: c!.name, type: ChannelType[c!.type] }));

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: send_message
// ------------------------------------------------------------------
server.registerTool(
  "send_message",
  {
    title: "Send Discord Message",
    description:
      "Sends a text message to a specific Discord channel. " +
      "Returns the ID of the sent message so it can be referenced later.",
    inputSchema: {
      channel_id: z.string().describe("The Discord channel ID to send to"),
      message: z.string().describe("The text content of the message"),
    },
  },
  async ({ channel_id, message }) => {
    const channel = await resolveTextChannel(channel_id);
    const sent = await channel.send(message);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ message_id: sent.id, timestamp: sent.createdAt.toISOString() }),
        },
      ],
    };
  }
);

// ------------------------------------------------------------------
// Tool: read_messages
// ------------------------------------------------------------------
server.registerTool(
  "read_messages",
  {
    title: "Read Recent Discord Messages",
    description:
      "Returns recent messages from the in-process message cache. " +
      "Optionally filter by channel_id. Messages are ordered oldest-first.",
    inputSchema: {
      channel_id: z
        .string()
        .optional()
        .describe("Filter to a specific channel ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of messages to return (default: 20, max: 100)"),
    },
  },
  async ({ channel_id, limit }) => {
    const max = limit ?? 20;
    let msgs = [...messageCache];
    if (channel_id) msgs = msgs.filter((m) => m.channelId === channel_id);
    msgs = msgs.slice(-max);
    const result = msgs.map(serializeMessage);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: get_channel_history
// ------------------------------------------------------------------
server.registerTool(
  "get_channel_history",
  {
    title: "Get Discord Channel History",
    description:
      "Fetches message history from a Discord channel via the API. " +
      "Supports pagination via before/after message IDs.",
    inputSchema: {
      channel_id: z.string().describe("The Discord channel ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Number of messages to fetch (default: 50, max: 100)"),
      before: z
        .string()
        .optional()
        .describe("Fetch messages before this message ID"),
      after: z
        .string()
        .optional()
        .describe("Fetch messages after this message ID"),
    },
  },
  async ({ channel_id, limit, before, after }) => {
    const channel = await resolveTextChannel(channel_id);

    const fetchOptions: Parameters<typeof channel.messages.fetch>[0] = {
      limit: limit ?? 50,
    };
    if (before) fetchOptions.before = before;
    if (after) fetchOptions.after = after;

    const messages: Collection<string, Message> =
      await channel.messages.fetch(fetchOptions);

    // Discord returns newest-first; reverse for chronological order
    const result = [...messages.values()]
      .reverse()
      .map(serializeMessage);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: wait_for_message
// ------------------------------------------------------------------
server.registerTool(
  "wait_for_message",
  {
    title: "Wait for Discord Message",
    description:
      "Polls until a new message arrives in the specified channel (optionally " +
      "matching a keyword) or the timeout expires. Ideal for command-response " +
      "flows such as waiting for a human to approve an action.",
    inputSchema: {
      channel_id: z.string().describe("The Discord channel ID to watch"),
      keyword: z
        .string()
        .optional()
        .describe("Optional substring the message content must contain"),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .default(60)
        .describe("Maximum seconds to wait (default: 60, max: 300)"),
      after_message_id: z
        .string()
        .optional()
        .describe(
          "Only consider messages newer than this message ID. " +
          "Pass the ID returned by send_message to wait for replies."
        ),
    },
  },
  async ({ channel_id, keyword, timeout_seconds, after_message_id }) => {
    await waitForReady();
    const timeoutMs = (timeout_seconds ?? 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 500;

    while (Date.now() < deadline) {
      // Look in the live cache first
      const candidate = messageCache.find((m) => {
        if (m.channelId !== channel_id) return false;
        if (after_message_id && BigInt(m.id) <= BigInt(after_message_id))
          return false;
        if (keyword && !m.content.includes(keyword)) return false;
        return true;
      });

      if (candidate) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(serializeMessage(candidate), null, 2),
            },
          ],
        };
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            timed_out: true,
            message: `No matching message received within ${timeout_seconds ?? 60}s`,
          }),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function main() {
  // Start Discord login in the background – MCP transport is available
  // immediately; tools will wait for the client to be ready before acting.
  discordClient.login(DISCORD_BOT_TOKEN).catch((err: unknown) => {
    process.stderr.write(`Discord login failed: ${String(err)}\n`);
    process.exit(1);
  });

  discordClient.once("ready", (client) => {
    process.stderr.write(`Discord bot ready: ${client.user.tag}\n`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
