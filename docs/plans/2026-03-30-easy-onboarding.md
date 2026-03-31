# Halobot Easy Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `halobot setup` (interactive wizard) and `halobot doctor` (diagnostic checks) CLI commands so first-time users can go from zero to working in under 5 minutes.

**Architecture:** New `src/cli.ts` file with all CLI logic. `src/index.ts` gets a 5-line router at the top that checks `process.argv[2]` and delegates to cli.ts for `setup`/`doctor`, otherwise starts the MCP server. CLI creates its own lightweight Discord client for validation (separate from the MCP server's client). Shared formatting helpers (`link()`, `check()`, `fail()`) keep output consistent.

**Tech Stack:** TypeScript, discord.js (for validation), Node built-in `readline` (for prompts), OSC 8 escape sequences (for clickable terminal links)

---

### Task 1: Create CLI formatting helpers and prompt utility

**Files:**
- Create: `src/cli.ts`

**Step 1: Create `src/cli.ts` with formatting helpers and prompt utility**

```typescript
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
// Terminal formatting
// ---------------------------------------------------------------------------

/** OSC 8 clickable terminal link. Falls back to plain text if unsupported. */
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
// Prompt helper
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

/** Extract the bot's client/application ID from a Discord bot token. */
function clientIdFromToken(token: string): string | null {
  try {
    const firstPart = token.split(".")[0];
    return Buffer.from(firstPart, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Build an OAuth2 invite URL with the required permissions. */
function buildInviteUrl(clientId: string): string {
  // ViewChannel | SendMessages | ReadMessageHistory | ManageThreads |
  // CreatePublicThreads | SendMessagesInThreads
  const permissions = "326417583104";
  return (
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&permissions=${permissions}&scope=bot`
  );
}

// ---------------------------------------------------------------------------
// Required bot permissions
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
```

**Step 2: Run the build to verify no compilation errors**

Run: `npx tsc --noEmit`
Expected: No errors (cli.ts exports some things but nothing imports it yet)

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI formatting helpers and prompt utilities"
```

---

### Task 2: Implement shared validation checks (used by both doctor and setup)

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add validation functions to `src/cli.ts`**

Append after the REQUIRED_PERMISSIONS constant:

```typescript
// ---------------------------------------------------------------------------
// Validation checks (shared by doctor and setup)
// ---------------------------------------------------------------------------

interface CheckEnvResult {
  token: string | undefined;
  channelId: string | undefined;
  guildId: string | undefined;
  allowedUsers: string[];
}

function checkEnvVars(): CheckEnvResult {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const allowedUsers = (process.env.DISCORD_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { token, channelId, guildId, allowedUsers };
}

interface ValidateResult {
  ok: boolean;
  botTag?: string;
  channelName?: string;
  usernames?: string[];
  missingPermissions?: string[];
}

async function validateConfig(opts: {
  token: string;
  channelId: string;
  guildId?: string;
  allowedUsers: string[];
  sendTest?: boolean;
}): Promise<ValidateResult> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  try {
    // --- Bot login ---
    await client.login(opts.token);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Bot did not become ready within 15s")),
        15_000
      );
      client.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const botTag = client.user?.tag ?? "unknown";
    check("Bot login", botTag);

    // --- Channel access ---
    const channel = await client.channels.fetch(opts.channelId);
    if (!channel) {
      fail("Channel access", `Channel ${opts.channelId} not found. Check DISCORD_CHANNEL_ID.`);
      return { ok: false };
    }
    if (
      !(channel instanceof TextChannel) &&
      !(channel instanceof NewsChannel)
    ) {
      fail(
        "Channel access",
        `Channel ${opts.channelId} is not a text channel (type: ${ChannelType[channel.type]}).`
      );
      return { ok: false };
    }
    check("Channel access", `#${channel.name} (${ChannelType[channel.type]})`);

    // --- Bot permissions ---
    const botMember = channel.guild.members.cache.get(client.user!.id) ??
      (await channel.guild.members.fetch(client.user!.id));
    const channelPerms = channel.permissionsFor(botMember);
    const missing = REQUIRED_PERMISSIONS.filter(
      (p) => !channelPerms?.has(p.flag)
    );

    if (missing.length > 0) {
      const names = missing.map((p) => p.name).join(", ");
      const clientId = client.user!.id;
      fail(
        "Bot permissions",
        `Missing: ${names}\n` +
          `    Re-invite the bot with correct permissions:\n` +
          `    ${link("Re-invite bot", buildInviteUrl(clientId))}`
      );
      return { ok: false, missingPermissions: missing.map((p) => p.name) };
    }
    const permNames = REQUIRED_PERMISSIONS.map((p) => p.name).join(", ");
    check("Bot permissions", permNames);

    // --- User verification ---
    const usernames: string[] = [];
    for (const userId of opts.allowedUsers) {
      try {
        const member =
          channel.guild.members.cache.get(userId) ??
          (await channel.guild.members.fetch(userId));
        usernames.push(member.user.username);
        check("User verification", `${member.user.username} (${userId})`);
      } catch {
        fail(
          "User verification",
          `User ${userId} not found in server. Check DISCORD_ALLOWED_USERS.`
        );
        return { ok: false };
      }
    }

    // --- Optional test message ---
    if (opts.sendTest) {
      try {
        await channel.send("halobot is configured correctly.");
        check("Test message", `sent to #${channel.name}`);
      } catch (err) {
        fail("Test message", `Failed to send: ${String(err)}`);
        return { ok: false };
      }
    }

    return { ok: true, botTag, channelName: channel.name, usernames };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("TOKEN_INVALID") || msg.includes("An invalid token was provided")) {
      fail("Bot login", "Invalid bot token. Check DISCORD_BOT_TOKEN.");
    } else {
      fail("Bot login", `Login failed: ${msg}`);
    }
    return { ok: false };
  } finally {
    client.destroy();
  }
}
```

**Step 2: Run the build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add shared validation checks for doctor and setup"
```

---

### Task 3: Implement the `doctor` command

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add the doctor function to `src/cli.ts`**

Append after `validateConfig`:

```typescript
// ---------------------------------------------------------------------------
// halobot doctor
// ---------------------------------------------------------------------------

export async function doctor(): Promise<void> {
  const sendTest = process.argv.includes("--test");

  heading("halobot doctor");

  const env = checkEnvVars();

  // Check required env vars
  if (env.token) {
    check("DISCORD_BOT_TOKEN", "set");
  } else {
    fail(
      "DISCORD_BOT_TOKEN",
      'Not set. Run "halobot setup" for guided configuration.'
    );
    process.exit(1);
  }

  if (env.channelId) {
    check("DISCORD_CHANNEL_ID", "set");
  } else {
    fail(
      "DISCORD_CHANNEL_ID",
      "Not set. Set it to the channel where threads should be created."
    );
    process.exit(1);
  }

  if (env.allowedUsers.length > 0) {
    check("DISCORD_ALLOWED_USERS", `set (${env.allowedUsers.length} user${env.allowedUsers.length > 1 ? "s" : ""})`);
  } else {
    fail(
      "DISCORD_ALLOWED_USERS",
      "Not set. Set it to a comma-separated list of Discord user IDs."
    );
    process.exit(1);
  }

  // Validate live
  const result = await validateConfig({
    token: env.token,
    channelId: env.channelId,
    guildId: env.guildId,
    allowedUsers: env.allowedUsers,
    sendTest,
  });

  process.stderr.write("\n");
  if (result.ok) {
    info("\x1b[32mAll checks passed.\x1b[0m\n");
  } else {
    info("\x1b[31mSome checks failed. Fix the issues above and re-run.\x1b[0m\n");
    process.exit(1);
  }
}
```

**Step 2: Run the build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add halobot doctor diagnostic command"
```

---

### Task 4: Implement the `setup` wizard

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add the setup function to `src/cli.ts`**

Append after the `doctor` function:

```typescript
// ---------------------------------------------------------------------------
// halobot setup
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  heading("halobot setup");
  info("This wizard will help you set up halobot.\n");

  // --- Step 1: Create bot and get token ---
  heading("Step 1: Create a Discord Bot");
  info(`Open the Discord Developer Portal:`);
  info(`  ${link("https://discord.com/developers/applications", "https://discord.com/developers/applications")}\n`);
  info("  1. Click \"New Application\" and give it a name");
  info("  2. Go to \"Bot\" in the sidebar");
  info("  3. Click \"Reset Token\" and copy it\n");

  const token = await prompt("Paste your bot token:");
  if (!token) {
    fail("Bot token", "No token provided.");
    process.exit(1);
  }

  // --- Step 2: Enable intents ---
  heading("Step 2: Enable Message Content Intent");
  info("In the Bot settings page, scroll to \"Privileged Gateway Intents\"");
  info("and enable:\n");
  info("  * MESSAGE CONTENT INTENT\n");
  await prompt("Press Enter when done...");

  // --- Step 3: Invite the bot ---
  heading("Step 3: Invite the bot to your server");
  const clientId = clientIdFromToken(token);
  if (clientId) {
    const inviteUrl = buildInviteUrl(clientId);
    info("Open this link to invite the bot:\n");
    info(`  ${link(inviteUrl, inviteUrl)}\n`);
  } else {
    info("Could not extract client ID from token.");
    info("Generate an invite URL in the Developer Portal:");
    info("  OAuth2 -> URL Generator -> bot scope -> select permissions\n");
  }
  await prompt("Press Enter after inviting the bot...");

  // --- Step 4: Collect IDs ---
  heading("Step 4: Collect Discord IDs");
  info("Enable Developer Mode in Discord:");
  info("  Settings -> App Settings -> Advanced -> Developer Mode\n");
  info("Then right-click items to \"Copy ID\".\n");

  const channelId = await prompt("Paste the channel ID (where threads will be created):");
  if (!channelId) {
    fail("Channel ID", "No channel ID provided.");
    process.exit(1);
  }

  const userIds = await prompt("Paste your Discord user ID (comma-separated for multiple):");
  if (!userIds) {
    fail("User ID", "No user ID provided.");
    process.exit(1);
  }
  const allowedUsers = userIds.split(",").map((s) => s.trim()).filter(Boolean);

  // --- Step 5: Validate ---
  heading("Step 5: Validating configuration");

  const result = await validateConfig({
    token,
    channelId,
    allowedUsers,
  });

  if (!result.ok) {
    process.stderr.write("\n");
    info("\x1b[31mValidation failed. Fix the issues above and re-run setup.\x1b[0m\n");
    process.exit(1);
  }

  process.stderr.write("\n");
  info("\x1b[32mValidation passed!\x1b[0m\n");

  // --- Step 6: Configure MCP client ---
  heading("Step 6: Configure your MCP client");

  // Check if claude CLI is available
  let hasClaude = false;
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    hasClaude = true;
  } catch {
    // claude CLI not available
  }

  if (hasClaude) {
    const autoAdd = await promptYN("Add halobot to Claude Code now?");
    if (autoAdd) {
      try {
        const { execFileSync } = await import("child_process");
        execFileSync("claude", [
          "mcp", "add", "halobot",
          "-e", `DISCORD_BOT_TOKEN=${token}`,
          "-e", `DISCORD_CHANNEL_ID=${channelId}`,
          "-e", `DISCORD_ALLOWED_USERS=${allowedUsers.join(",")}`,
          "--", "halobot",
        ], { stdio: "inherit" });
        check("Claude Code", "halobot added as MCP server");
        process.stderr.write("\n");
        info("You're all set! Start Claude Code and halobot will be available.\n");
        return;
      } catch (err) {
        fail("Claude Code", `Failed to add: ${String(err)}`);
        info("You can add it manually -- see config below.\n");
      }
    }
  }

  // Print config snippets
  info("Add halobot to your MCP client:\n");

  info("\x1b[1mClaude Code (CLI):\x1b[0m\n");
  info(`  claude mcp add halobot \\`);
  info(`    -e DISCORD_BOT_TOKEN=${token} \\`);
  info(`    -e DISCORD_CHANNEL_ID=${channelId} \\`);
  info(`    -e DISCORD_ALLOWED_USERS=${allowedUsers.join(",")} \\`);
  info(`    -- halobot\n`);

  info("\x1b[1mClaude Desktop (claude_desktop_config.json):\x1b[0m\n");
  info(`  {`);
  info(`    "mcpServers": {`);
  info(`      "halobot": {`);
  info(`        "command": "halobot",`);
  info(`        "env": {`);
  info(`          "DISCORD_BOT_TOKEN": "${token}",`);
  info(`          "DISCORD_CHANNEL_ID": "${channelId}",`);
  info(`          "DISCORD_ALLOWED_USERS": "${allowedUsers.join(",")}"`);
  info(`        }`);
  info(`      }`);
  info(`    }`);
  info(`  }\n`);

  info("You're all set! Start your MCP client and halobot will be available.\n");
}
```

**Step 2: Run the build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add halobot setup interactive wizard"
```

---

### Task 5: Add CLI routing to `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Step 1: Add CLI routing at the top of `src/index.ts`**

Insert immediately after the shebang line (line 1) and before the JSDoc comment (line 2):

```typescript
// CLI subcommands — handled before any MCP/Discord initialization
const subcommand = process.argv[2];
if (subcommand === "setup" || subcommand === "doctor") {
  import("./cli.js").then((cli) => {
    const fn = subcommand === "setup" ? cli.setup : cli.doctor;
    fn().catch((err) => {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exit(1);
    });
  });
} else {
```

Then at the very end of the file (after the `main().catch(...)` block), close the `else`:

```typescript
}
```

This ensures that when `setup` or `doctor` runs, the MCP server code (Discord client, dotenv import, etc.) never executes.

**Step 2: Improve the missing-token error in `main()`**

Replace the error in `main()` (around line 937):

```typescript
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
  }
```

With:

```typescript
  if (!DISCORD_BOT_TOKEN) {
    process.stderr.write(
      '\n  Missing DISCORD_BOT_TOKEN.\n' +
      '  Run "halobot setup" for guided configuration,\n' +
      '  or "halobot doctor" to diagnose an existing setup.\n\n'
    );
    process.exit(1);
  }
```

**Step 3: Run the build to verify**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run tests**

Run: `npx tsx src/index.test.ts`
Expected: All 28 tests pass

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: route setup/doctor subcommands before MCP server init"
```

---

### Task 6: Update package.json metadata

**Files:**
- Modify: `package.json`

**Step 1: Update package.json**

Add keywords, author, and convenience scripts. The full changes:

1. Add keywords:
```json
"keywords": [
  "mcp",
  "discord",
  "ai-agent",
  "human-in-the-loop",
  "claude",
  "model-context-protocol",
  "halobot"
],
```

2. Add author:
```json
"author": "Anthony Maio",
```

3. Add convenience scripts:
```json
"setup": "tsx src/cli.ts setup",
"doctor": "tsx src/cli.ts doctor"
```
(These go alongside the existing scripts, for dev convenience -- the real entry point is the `bin` field.)

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add npm keywords, author, and convenience scripts"
```

---

### Task 7: Update README with setup wizard and doctor sections

**Files:**
- Modify: `README.md`

**Step 1: Rewrite the Setup section**

Replace the entire `## Setup` section (from `## Setup` through the end of `### 4. Configure Your MCP Client` including the `Any STDIO MCP Client` block) with:

```markdown
## Quick Start

\`\`\`bash
# Install globally
npm install -g halobot

# Interactive setup -- walks you through everything
halobot setup
\`\`\`

The setup wizard will:
1. Link you to the Discord Developer Portal to create a bot
2. Generate the invite URL with correct permissions
3. Collect your channel and user IDs
4. Validate everything works (login, permissions, channel access)
5. Optionally add halobot to Claude Code automatically

### Manual Setup

If you prefer to configure manually:

#### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) -> New Application
2. Navigate to **Bot** -> create bot
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Copy the bot token
5. Invite the bot using OAuth2 URL Generator with `bot` scope and these permissions:
   - Send Messages, Create Public Threads, Send Messages in Threads
   - Read Message History, Manage Threads, View Channels

#### 2. Configure Your MCP Client

**Claude Code (CLI):**

\`\`\`bash
claude mcp add halobot \\
  -e DISCORD_BOT_TOKEN=your-token \\
  -e DISCORD_CHANNEL_ID=your-channel-id \\
  -e DISCORD_ALLOWED_USERS=your-user-id \\
  -- halobot
\`\`\`

**Claude Desktop (`claude_desktop_config.json`):**

\`\`\`json
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
\`\`\`

**Finding IDs:** Enable Developer Mode in Discord settings -> right-click channel/user -> Copy ID.

### Diagnostics

\`\`\`bash
# Check your setup
halobot doctor

# Check setup and send a test message
halobot doctor --test
\`\`\`
```

**Step 2: Run build to verify README changes didn't break anything**

Run: `npx tsc --noEmit && npx tsx src/index.test.ts`
Expected: Clean build, 28 tests pass

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite setup section with wizard-first approach"
```

---

### Task 8: Final verification

**Step 1: Full build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `npx tsx src/index.test.ts`
Expected: All 28 tests pass, 0 failed

**Step 3: Test CLI routing (no live Discord needed)**

Run: `npx tsx src/index.ts doctor 2>&1 | head -5`
Expected: Should print the doctor heading and then fail on missing DISCORD_BOT_TOKEN (since no .env is loaded in test context). This verifies the routing works.

**Step 4: Review final file structure**

```
src/
  helpers.ts    -- pure functions (serialize, chunk, validate, format)
  cli.ts        -- setup wizard + doctor command + shared validation
  index.ts      -- CLI router + Discord client + MCP server + tools
  index.test.ts -- tests for helpers
```

**Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: halobot easy onboarding -- setup wizard and doctor command"
```
