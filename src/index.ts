#!/usr/bin/env node
/**
 * agent-discord: An MCP server that allows any MCP-capable agent to
 * communicate with Discord — send messages, read messages, list guilds and
 * channels, manage threaded conversations, and wait for replies.
 *
 * Provides both low-level Discord access AND a high-level, thread-based
 * human-in-the-loop conversation model with user whitelisting.
 *
 * Required environment variables:
 *   DISCORD_BOT_TOKEN  – your Discord bot token
 *
 * Optional:
 *   DISCORD_GUILD_ID       – default guild (server) ID
 *   DISCORD_CHANNEL_ID     – default channel for thread-based conversations
 *   DISCORD_ALLOWED_USERS  – comma-separated user IDs for whitelisted access
 *   MESSAGE_CACHE_SIZE     – incoming message buffer size (default: 100)
 *   POLL_INTERVAL_MS       – reply poll interval in ms (default: 2000)
 *   REPLY_TIMEOUT_SECONDS  – max wait for replies (default: 300)
 *   MAX_MESSAGE_LENGTH     – chunk messages longer than this (default: 1900)
 */

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ThreadChannel,
  Collection,
  Message,
  ChannelType,
  Partials,
} from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  serializeMessage,
  chunkMessage,
  validateAllowedUser,
  getDefaultUserId,
  formatThreadName,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const DEFAULT_GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID ?? "";
const MESSAGE_CACHE_SIZE = parseInt(
  process.env.MESSAGE_CACHE_SIZE ?? "100",
  10
);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "2000", 10);
const DEFAULT_REPLY_TIMEOUT = parseInt(
  process.env.REPLY_TIMEOUT_SECONDS ?? "300",
  10
);
const MAX_MESSAGE_LENGTH = parseInt(
  process.env.MAX_MESSAGE_LENGTH ?? "1900",
  10
);

// Parse allowed users (empty = no whitelist enforcement on low-level tools)
const ALLOWED_USERS: Set<string> = new Set(
  (process.env.DISCORD_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
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
// Conversation tracking (thread-based)
// ---------------------------------------------------------------------------

interface Conversation {
  thread_id: string;
  channel_id: string;
  user_id: string;
  agent_name: string;
  created_at: string;
  last_agent_message_id: string | null;
}

/** Active thread-based conversations keyed by thread_id. */
const conversations = new Map<string, Conversation>();

const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (matches thread auto-archive)

function pruneConversations(): void {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - new Date(conv.created_at).getTime() > CONVERSATION_MAX_AGE_MS) {
      conversations.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Resolve a TextChannel by ID.
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

/**
 * Resolve an existing thread or create a new one.
 * Handles all three cases: tracked thread_id, untracked thread_id, and no thread_id.
 */
async function resolveOrCreateThread(opts: {
  thread_id?: string;
  channel_id: string;
  user_id: string;
  agent_name: string;
}): Promise<{ thread: ThreadChannel; conv: Conversation }> {
  pruneConversations();
  const { thread_id, channel_id, user_id, agent_name } = opts;

  if (thread_id) {
    const conv = conversations.get(thread_id);
    const fetched = await discordClient.channels.fetch(thread_id);
    if (!fetched || !fetched.isThread()) {
      throw new Error(`Thread ${thread_id} not found or not a thread`);
    }
    const thread = fetched as ThreadChannel;

    if (conv) {
      return { thread, conv };
    }

    const newConv: Conversation = {
      thread_id: thread.id,
      channel_id: thread.parentId ?? channel_id,
      user_id,
      agent_name,
      created_at: new Date().toISOString(),
      last_agent_message_id: null,
    };
    conversations.set(thread.id, newConv);
    return { thread, conv: newConv };
  }

  if (!channel_id) {
    throw new Error(
      "channel_id is required (or set DISCORD_CHANNEL_ID) to create a new thread."
    );
  }
  const channel = await resolveTextChannel(channel_id);
  const rootMsg = await channel.send(
    `🤖 **${agent_name}** is requesting your attention, <@${user_id}>.`
  );
  const thread = await rootMsg.startThread({
    name: formatThreadName(agent_name, new Date()),
    autoArchiveDuration: 1440,
  });
  const conv: Conversation = {
    thread_id: thread.id,
    channel_id,
    user_id,
    agent_name,
    created_at: new Date().toISOString(),
    last_agent_message_id: null,
  };
  conversations.set(thread.id, conv);
  return { thread, conv };
}

/**
 * Send chunked content to a thread and update the conversation's last message ID.
 */
async function sendToThread(
  thread: ThreadChannel,
  conv: Conversation,
  agentName: string,
  content: string
): Promise<{ chunks_sent: number }> {
  const chunks = chunkMessage(content, MAX_MESSAGE_LENGTH);
  let lastSent: Message | undefined;
  for (const chunk of chunks) {
    lastSent = await thread.send(`**${agentName}:**\n${chunk}`);
  }
  if (lastSent) {
    conv.last_agent_message_id = lastSent.id;
  }
  return { chunks_sent: chunks.length };
}

/**
 * Poll the messageCache for replies from a specific user in a thread.
 * Event-driven — no Discord API calls.
 */
function pollForReply(
  conv: Conversation,
  timeoutMs: number
): Promise<
  | { status: "replied"; reply: string; message_count: number }
  | { status: "timeout" }
> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      const userMessages = messageCache.filter((m) => {
        if (m.channelId !== conv.thread_id) return false;
        if (m.author.id !== conv.user_id) return false;
        if (m.author.bot) return false;
        if (
          conv.last_agent_message_id &&
          BigInt(m.id) <= BigInt(conv.last_agent_message_id)
        )
          return false;
        return true;
      });

      if (userMessages.length > 0) {
        // Advance cursor so the same messages aren't returned again
        const lastUserMsg = userMessages[userMessages.length - 1];
        conv.last_agent_message_id = lastUserMsg.id;

        const reply = userMessages.map((m) => m.content).join("\n");
        resolve({
          status: "replied",
          reply,
          message_count: userMessages.length,
        });
        return;
      }

      if (Date.now() >= deadline) {
        resolve({ status: "timeout" });
        return;
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "agent-discord",
  version: "2.0.0",
});

// ===================================================================
// LOW-LEVEL TOOLS (unchanged from v1 — general Discord access)
// ===================================================================

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
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: send_message (low-level, any channel)
// ------------------------------------------------------------------
server.registerTool(
  "send_message",
  {
    title: "Send Discord Message",
    description:
      "Sends a text message to a specific Discord channel. " +
      "Returns the ID of the sent message. For thread-based conversations, " +
      "use send_thread_message instead.",
    inputSchema: {
      channel_id: z.string().describe("The Discord channel ID to send to"),
      message: z.string().describe("The text content of the message"),
    },
  },
  async ({ channel_id, message }) => {
    const channel = await resolveTextChannel(channel_id);
    const chunks = chunkMessage(message, MAX_MESSAGE_LENGTH);
    let lastSent: Message | null = null;
    for (const chunk of chunks) {
      lastSent = await channel.send(chunk);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            message_id: lastSent!.id,
            timestamp: lastSent!.createdAt.toISOString(),
            chunks_sent: chunks.length,
          }),
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
        .describe(
          "Maximum number of messages to return (default: 20, max: 100)"
        ),
    },
  },
  async ({ channel_id, limit }) => {
    const max = limit ?? 20;
    let msgs = [...messageCache];
    if (channel_id) msgs = msgs.filter((m) => m.channelId === channel_id);
    msgs = msgs.slice(-max);
    const result = msgs.map(serializeMessage);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
    const result = [...messages.values()].reverse().map(serializeMessage);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ------------------------------------------------------------------
// Tool: wait_for_message (low-level, any channel)
// ------------------------------------------------------------------
server.registerTool(
  "wait_for_message",
  {
    title: "Wait for Discord Message",
    description:
      "Polls until a new message arrives in the specified channel (optionally " +
      "matching a keyword) or the timeout expires. For thread-based " +
      "conversations, use wait_for_reply instead.",
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
              type: "text" as const,
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
          type: "text" as const,
          text: JSON.stringify({
            timed_out: true,
            message: `No matching message received within ${timeout_seconds ?? 60}s`,
          }),
        },
      ],
    };
  }
);

// ===================================================================
// HIGH-LEVEL TOOLS (v2 — thread-based human-in-the-loop)
// ===================================================================

// ------------------------------------------------------------------
// Tool: send_thread_message
// ------------------------------------------------------------------
server.registerTool(
  "send_thread_message",
  {
    title: "Send Thread Message",
    description:
      "Send a message to a whitelisted user via a Discord thread. " +
      "Creates a new thread (and pings the user) or posts into an existing one. " +
      "Returns the thread_id for follow-up calls. Long messages are " +
      "automatically split across multiple Discord messages.",
    inputSchema: {
      content: z.string().describe("The message content to send"),
      user_id: z
        .string()
        .optional()
        .describe(
          "Discord user ID of the recipient. Must be whitelisted. " +
          "Defaults to the first user in DISCORD_ALLOWED_USERS."
        ),
      agent_name: z
        .string()
        .optional()
        .default("Agent")
        .describe("Display name for the agent in Discord"),
      thread_id: z
        .string()
        .optional()
        .describe(
          "Thread ID of an existing conversation to continue. " +
          "Omit to start a new conversation."
        ),
      channel_id: z
        .string()
        .optional()
        .describe(
          "Channel to create the thread in. Defaults to DISCORD_CHANNEL_ID."
        ),
    },
  },
  async ({ content, user_id, agent_name, thread_id, channel_id }) => {
    await waitForReady();

    const targetUser = user_id ?? getDefaultUserId(ALLOWED_USERS);
    validateAllowedUser(targetUser, ALLOWED_USERS);
    const agentLabel = agent_name ?? "Agent";
    const targetChannel = channel_id ?? DEFAULT_CHANNEL_ID;

    const { thread, conv } = await resolveOrCreateThread({
      thread_id,
      channel_id: targetChannel,
      user_id: targetUser,
      agent_name: agentLabel,
    });

    const { chunks_sent } = await sendToThread(thread, conv, agentLabel, content);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "sent",
              thread_id: conv.thread_id,
              user_id: conv.user_id,
              agent_name: conv.agent_name,
              chunks_sent,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ------------------------------------------------------------------
// Tool: wait_for_reply
// ------------------------------------------------------------------
server.registerTool(
  "wait_for_reply",
  {
    title: "Wait for Thread Reply",
    description:
      "Wait for the whitelisted user to reply in a conversation thread. " +
      "Polls the thread until the user responds or timeout is reached. " +
      "Returns the concatenated text of all new messages from the user.",
    inputSchema: {
      thread_id: z
        .string()
        .describe("The thread ID returned from send_thread_message"),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .default(DEFAULT_REPLY_TIMEOUT)
        .describe(
          `Max seconds to wait (default: ${DEFAULT_REPLY_TIMEOUT}, max: 600)`
        ),
    },
  },
  async ({ thread_id, timeout_seconds }) => {
    await waitForReady();

    const conv = conversations.get(thread_id);
    if (!conv) {
      throw new Error(
        `No tracked conversation for thread ${thread_id}. ` +
          `Use send_thread_message first.`
      );
    }

    const timeoutMs = (timeout_seconds ?? DEFAULT_REPLY_TIMEOUT) * 1000;
    const result = await pollForReply(conv, timeoutMs);

    if (result.status === "replied") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "replied",
                thread_id: conv.thread_id,
                reply: result.reply,
                message_count: result.message_count,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "timeout",
              thread_id: conv.thread_id,
              reply: null,
              waited_seconds: timeout_seconds ?? DEFAULT_REPLY_TIMEOUT,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ------------------------------------------------------------------
// Tool: send_and_wait
// ------------------------------------------------------------------
server.registerTool(
  "send_and_wait",
  {
    title: "Send Message and Wait for Reply",
    description:
      "Convenience tool: send a message to a user via a thread and wait " +
      "for their reply in one call. Best for simple question/answer exchanges. " +
      "Combines send_thread_message + wait_for_reply.",
    inputSchema: {
      content: z.string().describe("The message to send"),
      user_id: z
        .string()
        .optional()
        .describe("Discord user ID. Defaults to first allowed user."),
      agent_name: z
        .string()
        .optional()
        .default("Agent")
        .describe("Agent display name"),
      thread_id: z
        .string()
        .optional()
        .describe("Existing thread to continue, or omit for new"),
      channel_id: z
        .string()
        .optional()
        .describe("Channel for new threads. Defaults to DISCORD_CHANNEL_ID."),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .default(DEFAULT_REPLY_TIMEOUT)
        .describe("Max seconds to wait for reply"),
    },
  },
  async ({
    content,
    user_id,
    agent_name,
    thread_id,
    channel_id,
    timeout_seconds,
  }) => {
    await waitForReady();

    const targetUser = user_id ?? getDefaultUserId(ALLOWED_USERS);
    validateAllowedUser(targetUser, ALLOWED_USERS);
    const agentLabel = agent_name ?? "Agent";
    const targetChannel = channel_id ?? DEFAULT_CHANNEL_ID;

    const { thread, conv } = await resolveOrCreateThread({
      thread_id,
      channel_id: targetChannel,
      user_id: targetUser,
      agent_name: agentLabel,
    });

    await sendToThread(thread, conv, agentLabel, content);

    const timeoutMs = (timeout_seconds ?? DEFAULT_REPLY_TIMEOUT) * 1000;
    const result = await pollForReply(conv, timeoutMs);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: result.status,
              thread_id: conv.thread_id,
              reply: result.status === "replied" ? result.reply : null,
              ...(result.status === "replied"
                ? { message_count: result.message_count }
                : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ------------------------------------------------------------------
// Tool: list_conversations
// ------------------------------------------------------------------
server.registerTool(
  "list_conversations",
  {
    title: "List Active Conversations",
    description:
      "List all active thread-based conversations managed by this server. " +
      "Returns thread IDs, agent names, user IDs, and creation time.",
    inputSchema: {},
  },
  async () => {
    const result = [...conversations.values()].map((conv) => ({
      thread_id: conv.thread_id,
      user_id: conv.user_id,
      agent_name: conv.agent_name,
      created_at: conv.created_at,
      channel_id: conv.channel_id,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ conversations: result }, null, 2),
        },
      ],
    };
  }
);

// ------------------------------------------------------------------
// Tool: get_thread_messages
// ------------------------------------------------------------------
server.registerTool(
  "get_thread_messages",
  {
    title: "Get Thread Messages",
    description:
      "Retrieve the full message history of a conversation thread. " +
      "Useful for reviewing context before continuing a conversation.",
    inputSchema: {
      thread_id: z.string().describe("The thread ID to fetch messages from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max messages to return (default: 50)"),
    },
  },
  async ({ thread_id, limit }) => {
    await waitForReady();

    const thread = await discordClient.channels.fetch(thread_id);
    if (!thread || !thread.isThread()) {
      throw new Error(`Thread ${thread_id} not found or not a thread`);
    }

    const messages = await thread.messages.fetch({ limit: limit ?? 50 });
    const result = [...messages.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((msg) => ({
        author: msg.author.displayName ?? msg.author.username,
        author_id: msg.author.id,
        content: msg.content,
        timestamp: msg.createdAt.toISOString(),
        is_bot: msg.author.bot,
      }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ messages: result }, null, 2),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function main() {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
  }

  discordClient.login(DISCORD_BOT_TOKEN).catch((err: unknown) => {
    process.stderr.write(`Discord login failed: ${String(err)}\n`);
    process.exit(1);
  });

  discordClient.once("ready", (client) => {
    process.stderr.write(`Discord bot ready: ${client.user.tag}\n`);
    if (ALLOWED_USERS.size > 0) {
      process.stderr.write(
        `Whitelisted users: ${[...ALLOWED_USERS].join(", ")}\n`
      );
    } else {
      process.stderr.write(
        `WARNING: No DISCORD_ALLOWED_USERS configured. Thread tools will require explicit user_id.\n`
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    process.stderr.write("Shutting down…\n");
    discordClient.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
