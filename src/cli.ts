import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  TextChannel,
  NewsChannel,
  ChannelType,
  Partials,
} from "discord.js";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Terminal formatting helpers
// ---------------------------------------------------------------------------

/** OSC 8 clickable terminal link. */
export function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function check(label: string, detail?: string): void {
  const suffix = detail ? ` (${detail})` : "";
  process.stderr.write(`  \x1b[32m✓\x1b[0m ${label}${suffix}\n`);
}

function fail(label: string, fix: string): void {
  process.stderr.write(`  \x1b[31m✗\x1b[0m ${label}\n`);
  process.stderr.write(`    ${fix}\n`);
}

function heading(text: string): void {
  process.stderr.write(`\n  \x1b[1m${text}\x1b[0m\n`);
  process.stderr.write(`  ${"─".repeat(40)}\n\n`);
}

function info(text: string): void {
  process.stderr.write(`  ${text}\n`);
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(`  ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptYN(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  return prompt(`${question} ${hint}`).then((answer) => {
    if (!answer) return defaultYes;
    return answer.toLowerCase().startsWith("y");
  });
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

function clientIdFromToken(token: string): string | null {
  try {
    const firstPart = token.split(".")[0];
    return Buffer.from(firstPart, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function buildInviteUrl(clientId: string): string {
  const permissions = "326417583104";
  return (
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&permissions=${permissions}&scope=bot`
  );
}

// ---------------------------------------------------------------------------
// Required permissions
// ---------------------------------------------------------------------------

const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: "View Channels" },
  { flag: PermissionFlagsBits.SendMessages, name: "Send Messages" },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: "Read Message History" },
  { flag: PermissionFlagsBits.ManageThreads, name: "Manage Threads" },
  { flag: PermissionFlagsBits.CreatePublicThreads, name: "Create Public Threads" },
  {
    flag: PermissionFlagsBits.SendMessagesInThreads,
    name: "Send Messages in Threads",
  },
] as const;

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

function checkEnvVars(): {
  token: string | undefined;
  channelId: string | undefined;
  guildId: string | undefined;
  allowedUsers: string[];
} {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const allowedUsers = (process.env.DISCORD_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { token, channelId, guildId, allowedUsers };
}

interface ValidateConfigOpts {
  token: string;
  channelId: string;
  guildId?: string;
  allowedUsers: string[];
  sendTestMessage?: boolean;
}

interface ValidateConfigResult {
  ok: boolean;
  botTag?: string;
  channelName?: string;
  usernames?: string[];
  missingPermissions?: string[];
}

async function validateConfig(
  opts: ValidateConfigOpts
): Promise<ValidateConfigResult> {
  const { token, channelId, allowedUsers, sendTestMessage } = opts;
  const result: ValidateConfigResult = { ok: true };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  try {
    // Login
    try {
      await client.login(token);
      await new Promise<void>((resolve, reject) => {
        if (client.isReady()) {
          resolve();
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Client did not become ready in 15 seconds")),
          15_000
        );
        client.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      result.botTag = client.user?.tag;
      check("Bot login", result.botTag);
    } catch (err) {
      fail("Bot login", `Could not log in. Is the token correct? ${String(err)}`);
      result.ok = false;
      return result;
    }

    // Check channel
    let channel: TextChannel | NewsChannel;
    try {
      const fetched = await client.channels.fetch(channelId);
      if (!fetched) {
        throw new Error("Channel not found");
      }
      if (
        !(fetched instanceof TextChannel) &&
        !(fetched instanceof NewsChannel)
      ) {
        throw new Error(
          `Channel is type ${ChannelType[fetched.type]}, expected Text or Announcement`
        );
      }
      channel = fetched;
      result.channelName = channel.name;
      check("Channel exists", `#${channel.name}`);
    } catch (err) {
      fail(
        "Channel lookup",
        `Could not fetch channel ${channelId}. ${String(err)}`
      );
      result.ok = false;
      return result;
    }

    // Check permissions
    const botMember = channel.guild.members.cache.get(client.user!.id);
    if (!botMember) {
      try {
        await channel.guild.members.fetch(client.user!.id);
      } catch {
        // member fetch may fail; permissions check will still work via channel
      }
    }

    const permissions = channel.permissionsFor(client.user!.id);
    const missingPermissions: string[] = [];

    for (const perm of REQUIRED_PERMISSIONS) {
      if (permissions && permissions.has(perm.flag)) {
        check(perm.name);
      } else {
        fail(perm.name, "Grant this permission to the bot role in your server.");
        missingPermissions.push(perm.name);
      }
    }

    if (missingPermissions.length > 0) {
      result.missingPermissions = missingPermissions;
      result.ok = false;
    }

    // Verify user IDs
    const usernames: string[] = [];
    for (const userId of allowedUsers) {
      try {
        const guildId = channel.guild.id;
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        const name = member.user.tag;
        usernames.push(name);
        check(`User ${userId}`, name);
      } catch {
        fail(
          `User ${userId}`,
          "Could not find this user in the server. Check the ID and make sure they are a member."
        );
        result.ok = false;
      }
    }
    result.usernames = usernames;

    // Optional test message
    if (sendTestMessage && result.ok) {
      try {
        await channel.send(
          "✅ **halobot doctor**: test message sent successfully. You can delete this."
        );
        check("Test message sent");
      } catch (err) {
        fail("Test message", `Could not send a message. ${String(err)}`);
        result.ok = false;
      }
    }
  } finally {
    client.destroy();
  }

  return result;
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

export async function doctor(): Promise<void> {
  const sendTest = process.argv.includes("--test");

  heading("halobot doctor");

  const { token, channelId, allowedUsers } = checkEnvVars();

  if (!token) {
    fail(
      "DISCORD_BOT_TOKEN",
      "Set this env var to your bot token. Run `halobot setup` for help."
    );
    process.exit(1);
  }
  check("DISCORD_BOT_TOKEN");

  if (!channelId) {
    fail(
      "DISCORD_CHANNEL_ID",
      "Set this env var to the channel where threads will be created."
    );
    process.exit(1);
  }
  check("DISCORD_CHANNEL_ID");

  if (allowedUsers.length === 0) {
    fail(
      "DISCORD_ALLOWED_USERS",
      "Set this env var to a comma-separated list of Discord user IDs."
    );
    process.exit(1);
  }
  check("DISCORD_ALLOWED_USERS", allowedUsers.join(", "));

  info("");
  info("Connecting to Discord...");
  info("");

  const result = await validateConfig({
    token,
    channelId,
    allowedUsers,
    sendTestMessage: sendTest,
  });

  info("");
  if (result.ok) {
    info("\x1b[32mAll checks passed.\x1b[0m");
  } else {
    info("\x1b[31mSome checks failed.\x1b[0m");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// setup wizard
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  heading("halobot setup");

  info("This wizard will help you configure halobot step by step.\n");

  // Step 1: Bot token
  info("Step 1 of 6: Create a Discord bot\n");
  const portalUrl = "https://discord.com/developers/applications";
  info(
    `  Open the Discord Developer Portal: ${link("Developer Portal", portalUrl)}`
  );
  info("  Click 'New Application', give it a name, then go to the Bot tab.");
  info("  Click 'Reset Token' and copy the token.\n");

  const token = await prompt("Paste your bot token:");
  if (!token) {
    fail("No token provided", "A bot token is required to continue.");
    process.exit(1);
  }
  check("Bot token received");
  info("");

  // Step 2: Message Content Intent
  info("Step 2 of 6: Enable Message Content Intent\n");
  info("  In the Developer Portal, go to your app's Bot tab.");
  info("  Scroll down to 'Privileged Gateway Intents'.");
  info("  Enable 'MESSAGE CONTENT INTENT' and save.\n");

  await prompt("Press Enter when done...");
  check("Message Content Intent acknowledged");
  info("");

  // Step 3: Invite the bot
  info("Step 3 of 6: Invite the bot to your server\n");
  const clientId = clientIdFromToken(token);
  if (!clientId) {
    fail(
      "Could not extract client ID from token",
      "The token may be malformed. Please check it."
    );
    process.exit(1);
  }

  const inviteUrl = buildInviteUrl(clientId);
  info(`  Click this link to invite your bot: ${link("Invite Bot", inviteUrl)}`);
  info(`  (URL: ${inviteUrl})\n`);

  await prompt("Press Enter after inviting the bot...");
  check("Bot invited");
  info("");

  // Step 4: Channel ID and User IDs
  info("Step 4 of 6: Channel and user configuration\n");
  info("  To get IDs, enable Developer Mode in Discord:");
  info("  Settings > Advanced > Developer Mode\n");
  info("  Then right-click a channel or user and select 'Copy ID'.\n");

  const channelId = await prompt("Paste the channel ID for bot threads:");
  if (!channelId) {
    fail("No channel ID provided", "A channel ID is required.");
    process.exit(1);
  }
  check("Channel ID received", channelId);

  const userIdsRaw = await prompt(
    "Paste user ID(s) who can interact with the bot (comma-separated):"
  );
  if (!userIdsRaw) {
    fail("No user IDs provided", "At least one user ID is required.");
    process.exit(1);
  }
  const allowedUsers = userIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  check("User IDs received", allowedUsers.join(", "));
  info("");

  // Step 5: Validate
  info("Step 5 of 6: Validating configuration\n");
  info("  Connecting to Discord...\n");

  const result = await validateConfig({
    token,
    channelId,
    allowedUsers,
    sendTestMessage: false,
  });

  info("");
  if (!result.ok) {
    fail(
      "Validation failed",
      "Fix the issues above and run setup again."
    );
    process.exit(1);
  }
  check("All validation checks passed");
  info("");

  // Step 6: Configure Claude
  info("Step 6 of 6: Configure your MCP client\n");

  let hasClaude = false;
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    hasClaude = true;
  } catch {
    hasClaude = false;
  }

  if (hasClaude) {
    const autoAdd = await promptYN(
      "Claude Code CLI detected. Auto-configure halobot as an MCP server?"
    );

    if (autoAdd) {
      try {
        const { execFileSync } = await import("child_process");
        execFileSync(
          "claude",
          [
            "mcp",
            "add",
            "halobot",
            "-e",
            `DISCORD_BOT_TOKEN=${token}`,
            "-e",
            `DISCORD_CHANNEL_ID=${channelId}`,
            "-e",
            `DISCORD_ALLOWED_USERS=${allowedUsers.join(",")}`,
            "--",
            "npx",
            "-y",
            "halobot",
          ],
          { stdio: "inherit" }
        );
        check("halobot added to Claude Code");
        info("\n  You're all set! Try asking Claude to send a Discord message.\n");
        return;
      } catch (err) {
        fail(
          "Auto-configure failed",
          `Could not run claude mcp add. ${String(err)}`
        );
        info("  Falling back to manual instructions.\n");
      }
    }
  }

  // Manual instructions
  info("  Add halobot to your MCP client manually:\n");

  info("  \x1b[1mClaude Code CLI:\x1b[0m");
  info("  Run this command:\n");
  info(
    `    claude mcp add halobot \\`
  );
  info(`      -e DISCORD_BOT_TOKEN=${token} \\`);
  info(`      -e DISCORD_CHANNEL_ID=${channelId} \\`);
  info(`      -e DISCORD_ALLOWED_USERS=${allowedUsers.join(",")} \\`);
  info(`      -- npx -y halobot\n`);

  info("  \x1b[1mClaude Desktop (claude_desktop_config.json):\x1b[0m\n");
  const desktopConfig = {
    mcpServers: {
      halobot: {
        command: "npx",
        args: ["-y", "halobot"],
        env: {
          DISCORD_BOT_TOKEN: token,
          DISCORD_CHANNEL_ID: channelId,
          DISCORD_ALLOWED_USERS: allowedUsers.join(","),
        },
      },
    },
  };
  info(`    ${JSON.stringify(desktopConfig, null, 2).split("\n").join("\n    ")}`);
  info("");
}
