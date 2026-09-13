// Sets the bot's public profile: name, descriptions, command menus per chat type, profile photo.
// Usage: npm run profile            (text + commands)
//        npm run profile -- --photo  (also uploads assets/avatar.jpg)
import { Bot, InputFile } from "grammy";

import { botToken } from "../src/config.js";

const api = new Bot(botToken()).api;

const NAME = "CookieBot";

// Shown on the profile page and in link previews (max 120 characters).
const SHORT_DESCRIPTION = "Wallet alerts, price alerts and COOK tips for Cookie Chain. You sign in Nightly; the bot never holds keys.";

// Shown in an empty chat before the user presses Start (max 512 characters).
const DESCRIPTION = [
  "CookieBot keeps Cookie Chain in your chats.",
  "",
  "• A message within seconds whenever a wallet you watch moves",
  "• One-time price alerts, set in two taps",
  "• COOK tips in groups: reply with /tip 500 and the message confirms itself once paid",
  "• Portfolio and market cards with live prices",
  "",
  "Payments are signed in your Nightly wallet. The bot only reads the chain.",
].join("\n");

const PRIVATE_COMMANDS = [
  { command: "start", description: "Menu" },
  { command: "watch", description: "Get a message on every transfer of a wallet" },
  { command: "portfolio", description: "Balances of a wallet in USD" },
  { command: "price", description: "Live price card for a token" },
  { command: "alert", description: "One-time price alert" },
  { command: "top", description: "Deepest COOK pairs right now" },
  { command: "tip", description: "Tip someone in COOK" },
  { command: "link", description: "Link your own wallet" },
  { command: "settings", description: "Watched wallets and alerts" },
  { command: "help", description: "All commands" },
];

const GROUP_COMMANDS = [
  { command: "tip", description: "Reply to a message: /tip 500" },
  { command: "price", description: "Live price card: /price bCOOK" },
  { command: "top", description: "Deepest COOK pairs right now" },
  { command: "watch", description: "Post every move of a wallet here" },
  { command: "settings", description: "What this group is watching" },
];

if (NAME.length > 64 || SHORT_DESCRIPTION.length > 120 || DESCRIPTION.length > 512) {
  throw new Error(`Profile text too long: name ${NAME.length}/64, short ${SHORT_DESCRIPTION.length}/120, description ${DESCRIPTION.length}/512`);
}

await api.raw.setMyName({ name: NAME });
await api.raw.setMyShortDescription({ short_description: SHORT_DESCRIPTION });
await api.raw.setMyDescription({ description: DESCRIPTION });
await api.raw.setMyCommands({ commands: PRIVATE_COMMANDS });
await api.raw.setMyCommands({ commands: PRIVATE_COMMANDS, scope: { type: "all_private_chats" } });
await api.raw.setMyCommands({ commands: GROUP_COMMANDS, scope: { type: "all_group_chats" } });
await api.raw.setChatMenuButton({ menu_button: { type: "commands" } });
console.log(`✔ name, descriptions (${SHORT_DESCRIPTION.length}/120, ${DESCRIPTION.length}/512), commands, menu button`);

if (process.argv.includes("--photo")) {
  await api.raw.setMyProfilePhoto({ photo: { type: "static", photo: new InputFile(new URL("../assets/avatar.jpg", import.meta.url).pathname) } });
  console.log("✔ profile photo");
}

const me = await api.getMe();
console.log(`@${me.username}: ${(await api.raw.getMyName({})).name}`);
