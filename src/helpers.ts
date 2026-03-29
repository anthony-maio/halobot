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
