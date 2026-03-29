/**
 * Unit tests for agent-discord MCP server helper logic.
 *
 * These tests do NOT require a live Discord connection or real bot token.
 * They exercise the pure-logic helpers (message serialisation, cache
 * filtering, chunking, whitelist validation) by importing only the parts
 * that have no side-effects.
 */

import { strict as assert } from "assert";
import { Message } from "discord.js";
import { serializeMessage, chunkMessage, validateAllowedUser, getDefaultUserId, formatThreadName } from "./helpers.js";

// ---------------------------------------------------------------------------
// Minimal stub for a discord.js Message (only the fields we touch)
// ---------------------------------------------------------------------------

interface StubAttachment {
  url: string;
  name: string;
}

interface StubEmbed {
  title: string | null;
  description: string | null;
}

interface StubMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author: { id: string; username: string; bot: boolean };
  content: string;
  createdAt: Date;
  attachments: Map<string, StubAttachment>;
  embeds: StubEmbed[];
}

// ---------------------------------------------------------------------------
// Inline copy of message-cache read logic
// ---------------------------------------------------------------------------

function readMessages(
  cache: StubMessage[],
  opts: { channel_id?: string; limit?: number }
) {
  const max = opts.limit ?? 20;
  let msgs = [...cache];
  if (opts.channel_id)
    msgs = msgs.filter((m) => m.channelId === opts.channel_id);
  return msgs.slice(-max).map((m) => serializeMessage(m as unknown as Message));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<StubMessage> = {}): StubMessage {
  return {
    id: "1000000000000000001",
    channelId: "channel-1",
    guildId: "guild-1",
    author: { id: "user-1", username: "TestUser", bot: false },
    content: "hello world",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    attachments: new Map(),
    embeds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${String(err)}`);
    failed++;
  }
}

// --- serializeMessage ---

console.log("\nserializeMessage");

test("serialises basic fields", () => {
  const msg = makeMessage({ content: "ping", id: "42" });
  const s = serializeMessage(msg as unknown as Message);
  assert.equal(s.id, "42");
  assert.equal(s.content, "ping");
  assert.equal(s.channel_id, "channel-1");
  assert.equal(s.guild_id, "guild-1");
  assert.equal(s.author.username, "TestUser");
  assert.equal(s.author.bot, false);
});

test("handles null guildId", () => {
  const msg = makeMessage({ guildId: null });
  assert.equal(serializeMessage(msg as unknown as Message).guild_id, null);
});

test("serialises attachments", () => {
  const msg = makeMessage();
  msg.attachments.set("a1", {
    url: "https://example.com/file.png",
    name: "file.png",
  });
  const s = serializeMessage(msg as unknown as Message);
  assert.equal(s.attachments.length, 1);
  assert.equal(s.attachments[0].url, "https://example.com/file.png");
});

test("serialises embeds", () => {
  const msg = makeMessage({
    embeds: [{ title: "Test", description: "desc" }],
  });
  const s = serializeMessage(msg as unknown as Message);
  assert.equal(s.embeds.length, 1);
  assert.equal(s.embeds[0].title, "Test");
});

test("timestamp is ISO 8601", () => {
  const msg = makeMessage({ createdAt: new Date("2024-06-15T12:00:00.000Z") });
  assert.equal(serializeMessage(msg as unknown as Message).timestamp, "2024-06-15T12:00:00.000Z");
});

// --- readMessages ---

console.log("\nreadMessages (cache filter logic)");

const cache: StubMessage[] = [
  makeMessage({ id: "1", channelId: "ch-a", content: "first" }),
  makeMessage({ id: "2", channelId: "ch-b", content: "second" }),
  makeMessage({ id: "3", channelId: "ch-a", content: "third" }),
  makeMessage({ id: "4", channelId: "ch-a", content: "fourth" }),
];

test("returns all messages when no channel_id given", () => {
  const result = readMessages(cache, {});
  assert.equal(result.length, 4);
});

test("filters by channel_id", () => {
  const result = readMessages(cache, { channel_id: "ch-a" });
  assert.equal(result.length, 3);
  assert.ok(result.every((m) => m.channel_id === "ch-a"));
});

test("respects limit", () => {
  const result = readMessages(cache, { limit: 2 });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "3");
  assert.equal(result[1].id, "4");
});

test("limit applied after channel filter", () => {
  const result = readMessages(cache, { channel_id: "ch-a", limit: 2 });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "3");
  assert.equal(result[1].id, "4");
});

test("returns empty array when channel has no messages", () => {
  const result = readMessages(cache, { channel_id: "ch-zzz" });
  assert.equal(result.length, 0);
});

// --- wait_for_message filter logic ---

console.log("\nwait_for_message filter logic");

function matchesWaitCriteria(
  msg: StubMessage,
  opts: { channel_id: string; keyword?: string; after_message_id?: string }
): boolean {
  if (msg.channelId !== opts.channel_id) return false;
  if (
    opts.after_message_id &&
    BigInt(msg.id) <= BigInt(opts.after_message_id)
  )
    return false;
  if (opts.keyword && !msg.content.includes(opts.keyword)) return false;
  return true;
}

const waitCache: StubMessage[] = [
  makeMessage({ id: "100", channelId: "ch-x", content: "start here" }),
  makeMessage({
    id: "200",
    channelId: "ch-x",
    content: "approve deployment",
  }),
  makeMessage({ id: "300", channelId: "ch-y", content: "other channel" }),
];

test("matches by channel_id", () => {
  assert.ok(matchesWaitCriteria(waitCache[0], { channel_id: "ch-x" }));
  assert.ok(!matchesWaitCriteria(waitCache[2], { channel_id: "ch-x" }));
});

test("filters by after_message_id", () => {
  assert.ok(
    matchesWaitCriteria(waitCache[1], {
      channel_id: "ch-x",
      after_message_id: "100",
    })
  );
  assert.ok(
    !matchesWaitCriteria(waitCache[0], {
      channel_id: "ch-x",
      after_message_id: "100",
    })
  );
});

test("filters by keyword", () => {
  assert.ok(
    matchesWaitCriteria(waitCache[1], {
      channel_id: "ch-x",
      keyword: "approve",
    })
  );
  assert.ok(
    !matchesWaitCriteria(waitCache[0], {
      channel_id: "ch-x",
      keyword: "approve",
    })
  );
});

test("keyword and after_message_id can be combined", () => {
  assert.ok(
    matchesWaitCriteria(waitCache[1], {
      channel_id: "ch-x",
      after_message_id: "100",
      keyword: "approve",
    })
  );
  assert.ok(
    !matchesWaitCriteria(waitCache[0], {
      channel_id: "ch-x",
      after_message_id: "100",
      keyword: "approve",
    })
  );
});

// --- chunkMessage ---

console.log("\nchunkMessage");

test("short message returns single chunk", () => {
  const chunks = chunkMessage("Hello", 1900);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Hello");
});

test("long message chunks at newlines", () => {
  const msg = "Line one\nLine two\nLine three\nLine four\nLine five is a bit longer";
  const chunks = chunkMessage(msg, 30);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 30));
  // All content should be preserved
  const reassembled = chunks.join("\n");
  assert.ok(reassembled.includes("Line one"));
  assert.ok(reassembled.includes("Line five"));
});

test("hard cuts when no newlines available", () => {
  const msg = "abcdefghijklmnopqrstuvwxyz";
  const chunks = chunkMessage(msg, 10);
  assert.ok(chunks.every((c) => c.length <= 10));
  assert.equal(chunks.join(""), msg);
});

test("empty string returns single chunk", () => {
  const chunks = chunkMessage("", 1900);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "");
});

test("exactly max length returns single chunk", () => {
  const msg = "a".repeat(50);
  const chunks = chunkMessage(msg, 50);
  assert.equal(chunks.length, 1);
});

// --- validateAllowedUser ---

console.log("\nvalidateAllowedUser (whitelist)");

test("passes for allowed user", () => {
  const allowed = new Set(["111", "222"]);
  validateAllowedUser("111", allowed); // Should not throw
  validateAllowedUser("222", allowed);
});

test("throws for disallowed user", () => {
  const allowed = new Set(["111", "222"]);
  assert.throws(
    () => validateAllowedUser("999", allowed),
    /not in DISCORD_ALLOWED_USERS/
  );
});

test("skips validation when whitelist is empty", () => {
  const allowed = new Set<string>();
  validateAllowedUser("anyone", allowed); // Should not throw
});

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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
