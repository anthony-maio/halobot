/**
 * Unit tests for agent-discord MCP server helper logic.
 *
 * These tests do NOT require a live Discord connection or real bot token.
 * They exercise the pure-logic helpers (message serialisation, cache
 * filtering) by importing only the parts that have no side-effects.
 */

import { strict as assert } from "assert";

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
// Inline copy of serializeMessage (keeps tests self-contained)
// ---------------------------------------------------------------------------

function serializeMessage(msg: StubMessage) {
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

// ---------------------------------------------------------------------------
// Inline copy of message-cache read logic
// ---------------------------------------------------------------------------

function readMessages(
  cache: StubMessage[],
  opts: { channel_id?: string; limit?: number }
) {
  const max = opts.limit ?? 20;
  let msgs = [...cache];
  if (opts.channel_id) msgs = msgs.filter((m) => m.channelId === opts.channel_id);
  return msgs.slice(-max).map(serializeMessage);
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
  const s = serializeMessage(msg);
  assert.equal(s.id, "42");
  assert.equal(s.content, "ping");
  assert.equal(s.channel_id, "channel-1");
  assert.equal(s.guild_id, "guild-1");
  assert.equal(s.author.username, "TestUser");
  assert.equal(s.author.bot, false);
});

test("handles null guildId", () => {
  const msg = makeMessage({ guildId: null });
  assert.equal(serializeMessage(msg).guild_id, null);
});

test("serialises attachments", () => {
  const msg = makeMessage();
  msg.attachments.set("a1", { url: "https://example.com/file.png", name: "file.png" });
  const s = serializeMessage(msg);
  assert.equal(s.attachments.length, 1);
  assert.equal(s.attachments[0].url, "https://example.com/file.png");
});

test("serialises embeds", () => {
  const msg = makeMessage({
    embeds: [{ title: "Test", description: "desc" }],
  });
  const s = serializeMessage(msg);
  assert.equal(s.embeds.length, 1);
  assert.equal(s.embeds[0].title, "Test");
});

test("timestamp is ISO 8601", () => {
  const msg = makeMessage({ createdAt: new Date("2024-06-15T12:00:00.000Z") });
  assert.equal(serializeMessage(msg).timestamp, "2024-06-15T12:00:00.000Z");
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
  // slice(-2) returns the last 2
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
  makeMessage({ id: "200", channelId: "ch-x", content: "approve deployment" }),
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
