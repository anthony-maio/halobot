# Agent-Discord Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract pure helpers into a testable module, eliminate duplication between thread tools, switch from API polling to event-driven replies, and fix several reliability/correctness issues.

**Architecture:** Split `src/index.ts` into two files — `src/helpers.ts` (pure functions, no side effects) and `src/index.ts` (Discord client, MCP server, boot). Shared thread logic (resolve-or-create thread, send chunked message, poll for reply) becomes helper functions in `index.ts` called by all three thread tools. `wait_for_reply` switches from Discord API polling to scanning the existing `messageCache` populated by the `messageCreate` event.

**Tech Stack:** TypeScript, discord.js, @modelcontextprotocol/sdk, zod

---

### Task 1: Create `src/helpers.ts` with extracted pure functions

**Files:**
- Create: `src/helpers.ts`
- Modify: `src/index.ts` (remove duplicated functions, add imports)

**Step 1: Create `src/helpers.ts` with all pure helpers**

```typescript
import { Message } from "discord.js";

/**
 * Serialise a discord.js Message into a plain JSON-serialisable object.
 */
export function serializeMessage(msg: Message) {
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
    attachments: [...msg.attachments.values()].map((a) => ({
      url: a.url,
      name: a.name,
    })),
    embeds: msg.embeds.map((e) => ({
      title: e.title,
      description: e.description,
    })),
  };
}

/**
 * Split a message into Discord-safe chunks, breaking at newlines when possible.
 */
export function chunkMessage(
  content: string,
  maxLen: number = 1900
): string[] {
  if (content.length <= maxLen) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut === -1 || cut < maxLen / 2) {
      cut = maxLen;
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Validate that a user ID is in the allowed set.
 * No-op when allowedUsers is empty (no whitelist configured).
 */
export function validateAllowedUser(
  userId: string,
  allowedUsers: Set<string>
): void {
  if (allowedUsers.size === 0) return;
  if (!allowedUsers.has(userId)) {
    throw new Error(
      `User ${userId} is not in DISCORD_ALLOWED_USERS. ` +
        `Allowed: ${[...allowedUsers].join(", ")}`
    );
  }
}

/**
 * Get the default user ID (first allowed user, or throw).
 */
export function getDefaultUserId(allowedUsers: Set<string>): string {
  if (allowedUsers.size === 0) {
    throw new Error(
      "No user_id provided and DISCORD_ALLOWED_USERS is not configured."
    );
  }
  return [...allowedUsers][0];
}

/**
 * Format a thread name with a fixed UTC timestamp (not locale-dependent).
 */
export function formatThreadName(agentName: string, date: Date): string {
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const day = date.getUTCDate();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${agentName} — ${month} ${day}, ${hours}:${minutes} UTC`;
}
```

**Step 2: Update `src/index.ts` — replace inline helpers with imports**

At the top of `src/index.ts`, after the existing imports, add:

```typescript
import {
  serializeMessage,
  chunkMessage,
  validateAllowedUser as validateAllowedUserFn,
  getDefaultUserId as getDefaultUserIdFn,
  formatThreadName,
} from "./helpers.js";
```

Then delete the following functions from `src/index.ts` (they now live in `helpers.ts`):
- `serializeMessage` (lines 121-142)
- `chunkMessage` (lines 190-214)
- `validateAllowedUser` (lines 177-185) — replace all call sites with `validateAllowedUserFn(userId, ALLOWED_USERS)`
- `getDefaultUserId` (lines 219-226) — replace all call sites with `getDefaultUserIdFn(ALLOWED_USERS)`

Update the thread name creation at lines 602-607 and 830-835 to use:
```typescript
formatThreadName(agentLabel, new Date())
```

**Step 3: Run the build to verify no compilation errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/helpers.ts src/index.ts
git commit -m "refactor: extract pure helpers into src/helpers.ts"
```

---

### Task 2: Update tests to import from helpers

**Files:**
- Modify: `src/index.test.ts`

**Step 1: Rewrite `src/index.test.ts` to import from helpers**

Replace the inline copies of `serializeMessage`, `chunkMessage`, and `validateAllowedUser` with imports:

```typescript
import { serializeMessage, chunkMessage, validateAllowedUser, getDefaultUserId, formatThreadName } from "./helpers.js";
```

Remove:
- The inline `serializeMessage` function (lines 41-62)
- The inline `chunkMessage` function (lines 83-105)
- The inline `validateAllowedUser` function (lines 111-121)

Keep the `StubMessage` interface and `makeMessage` helper — tests still need those for creating test data. However, since the real `serializeMessage` accepts a `Message` from discord.js, cast the stub: `serializeMessage(makeMessage() as unknown as Message)`.

Update the `readMessages` function to use the imported `serializeMessage`.

Add tests for the new `formatThreadName` and `getDefaultUserId` functions:

```typescript
// --- formatThreadName ---

console.log("\nformatThreadName");

test("formats with UTC time", () => {
  const date = new Date("2024-06-15T14:30:00Z");
  const name = formatThreadName("Agent", date);
  assert.equal(name, "Agent — Jun 15, 14:30 UTC");
});

test("pads single-digit hours and minutes", () => {
  const date = new Date("2024-01-02T03:05:00Z");
  const name = formatThreadName("Bot", date);
  assert.equal(name, "Bot — Jan 2, 03:05 UTC");
});

// --- getDefaultUserId ---

console.log("\ngetDefaultUserId");

test("returns first allowed user", () => {
  const allowed = new Set(["111", "222"]);
  assert.equal(getDefaultUserId(allowed), "111");
});

test("throws when no users configured", () => {
  assert.throws(() => getDefaultUserId(new Set()), /DISCORD_ALLOWED_USERS/);
});
```

**Step 2: Run tests to verify they pass**

Run: `npx tsx src/index.test.ts`
Expected: All tests pass, 0 failed

**Step 3: Commit**

```bash
git add src/index.test.ts
git commit -m "test: import helpers from module instead of duplicating"
```

---

### Task 3: Defer token validation and fix process.exit

**Files:**
- Modify: `src/index.ts`

**Step 1: Move token validation into `main()`**

Replace lines 42-48 (the top-level token check) with:

```typescript
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
```

No `if` / `process.exit` at module level.

Then, at the very start of the `main()` function, add:

```typescript
async function main() {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
  }

  // ... rest of main
}
```

The existing `main().catch()` handler at the bottom will print and exit on this error.

**Step 2: Run build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: defer token validation to main() so module is importable"
```

---

### Task 4: Add graceful shutdown

**Files:**
- Modify: `src/index.ts`

**Step 1: Add shutdown handler inside `main()`, after `server.connect(transport)`**

```typescript
  const shutdown = () => {
    process.stderr.write("Shutting down…\n");
    discordClient.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
```

**Step 2: Run build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: add graceful shutdown on SIGINT/SIGTERM"
```

---

### Task 5: Extract shared thread logic and eliminate duplication

This is the biggest task — extract `resolveOrCreateThread` and `sendToThread` helpers, then rewrite all three thread tools to use them.

**Files:**
- Modify: `src/index.ts`

**Step 1: Add the `Conversation` interface export and shared helpers**

Add these functions after the existing helpers section in `index.ts`:

```typescript
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
  const { thread_id, channel_id, user_id, agent_name } = opts;

  if (thread_id) {
    // Try to use existing thread (tracked or untracked)
    const conv = conversations.get(thread_id);
    const fetched = await discordClient.channels.fetch(thread_id);
    if (!fetched || !fetched.isThread()) {
      throw new Error(`Thread ${thread_id} not found or not a thread`);
    }
    const thread = fetched as ThreadChannel;

    if (conv) {
      return { thread, conv };
    }

    // Untracked thread — register it
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

  // New conversation — create root message + thread
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
  const chunks = chunkMessage(content);
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
): Promise<{ status: "replied"; reply: string; message_count: number } | { status: "timeout" }> {
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
```

**Step 2: Rewrite `send_thread_message` tool handler**

Replace the entire handler (the async function in the third argument to `registerTool`) with:

```typescript
  async ({ content, user_id, agent_name, thread_id, channel_id }) => {
    await waitForReady();

    const targetUser = user_id ?? getDefaultUserIdFn(ALLOWED_USERS);
    validateAllowedUserFn(targetUser, ALLOWED_USERS);
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
```

**Step 3: Rewrite `wait_for_reply` tool handler**

Replace the entire handler with:

```typescript
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
```

**Step 4: Rewrite `send_and_wait` tool handler**

Replace the entire handler with:

```typescript
  async ({
    content,
    user_id,
    agent_name,
    thread_id,
    channel_id,
    timeout_seconds,
  }) => {
    await waitForReady();

    const targetUser = user_id ?? getDefaultUserIdFn(ALLOWED_USERS);
    validateAllowedUserFn(targetUser, ALLOWED_USERS);
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
```

**Step 5: Remove the now-unused `Collection` import from discord.js**

The `Collection` type was only used in `wait_for_reply`'s old API-polling code. Remove it from the import.

**Step 6: Run build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Run tests**

Run: `npx tsx src/index.test.ts`
Expected: All tests pass

**Step 8: Commit**

```bash
git add src/index.ts
git commit -m "refactor: extract shared thread logic, switch to event-driven polling"
```

---

### Task 6: Add conversation cleanup

**Files:**
- Modify: `src/index.ts`

**Step 1: Add cleanup constant and function after the conversations map**

```typescript
const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (matches thread auto-archive)

function pruneConversations(): void {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - new Date(conv.created_at).getTime() > CONVERSATION_MAX_AGE_MS) {
      conversations.delete(id);
    }
  }
}
```

**Step 2: Call `pruneConversations()` at the start of `resolveOrCreateThread`**

Add as the first line of the function body:

```typescript
  pruneConversations();
```

**Step 3: Run build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix: prune conversations older than 24h to prevent memory leak"
```

---

### Task 7: Final verification

**Step 1: Full build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `npx tsx src/index.test.ts`
Expected: All tests pass, 0 failed

**Step 3: Review final file structure**

```
src/
  helpers.ts    — pure functions (serializeMessage, chunkMessage, validateAllowedUser, getDefaultUserId, formatThreadName)
  index.ts      — Discord client, MCP server, thread helpers, tools, boot
  index.test.ts — tests importing from helpers.ts
```
