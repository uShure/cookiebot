// Renders every card with sample data and checks what Telegram would reject: `npm run cards`.
// Pass --print to see the text of each card.
import type { InlineKeyboardButton } from "grammy/types";

import { COOK_MINT, type Portfolio, type TokenInfo } from "../src/chain.js";
import type { PriceAlert, Tip, UserWallet, Watch } from "../src/store.js";
import * as ui from "../src/ui.js";

const ADDR = "4GGk4vTDd1FCA4NHd62xcwcab86KAm6dFtG7zrGKSGUx";
const MINT = "EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz";
const token: TokenInfo = { mint: MINT, symbol: "bCOOK", name: "Baked COOK", decimals: 9, priceUsd: 0.00009229, change24h: 5.57, liquidityCook: 2305.9, holders: 66 };
const cook: TokenInfo = { ...token, mint: COOK_MINT, symbol: "COOK", name: "Cookie Chain native token", priceUsd: 0.0000703, change24h: -1.2 };
const tokens = Array.from({ length: 19 }, (_, i) => ({ ...token, symbol: `TOK${i}<&>`, mint: MINT.slice(0, 40) + String(1000 + i) }));
const wallet: UserWallet = { user_id: 1, username: "andy", address: ADDR, name: "cookie.cook" };
const w: Watch = { chat_id: 1, address: ADDR, label: "Treasury <main>" };
const alert: PriceAlert = { id: 42, chat_id: 1, mint: MINT, symbol: "bCOOK", direction: "above", target: 0.0001015 };
const portfolio: Portfolio = {
  cook: 670012.6,
  cookUsd: 47.13,
  totalUsd: 1212.39,
  tokens: Array.from({ length: 54 }, (_, i) => ({ mint: MINT, symbol: i % 7 ? `T${i}` : "A&B", amount: 10_320_000 / (i + 1), usd: 952 / (i + 1) })),
};
const tip = (status: Tip["status"]): Tip => ({
  id: "a1b2c3d4e5", chat_id: -100123, message_id: 7, creator_id: 1, from_name: "@andy", to_address: ADDR, to_label: "cookie.cook",
  amount: 500, status, signature: status === "paid" ? "5".repeat(88) : null, created_at: 0,
});

const cards: [string, ui.Card][] = [
  ["home (private, no wallet)", ui.home(null, null, false)],
  ["home (private, wallet)", ui.home(wallet, 12500, false)],
  ["home (group)", ui.home(null, null, true)],
  ["help", ui.help()],
  ["error", ui.errorCard("gorbagana.cook is not registered <x>", ui.cb("Try again", "w:new"))],
  ["price", ui.priceCard(token)],
  ["price COOK", ui.priceCard(cook)],
  ["market p0", ui.marketCard(tokens, 0)],
  ["market p2", ui.marketCard(tokens, 2)],
  ["alert picker", ui.alertPicker(tokens)],
  ["alert presets", ui.alertPresets(token)],
  ["alert set", ui.alertSet(alert, 0.00009229)],
  ["alert fired", ui.alertFired(alert, 0.000102)],
  ["watching new", ui.watchingCard(w, "new")],
  ["watching renamed", ui.watchingCard(w, "renamed")],
  ["portfolio", ui.portfolioCard(ADDR, "cookie.cook", portfolio, false)],
  ["activity received", ui.activityCard({ kind: "received", address: ADDR, label: "Treasury", lines: [{ text: "+12,500 COOK", usd: "$0.88" }], counterparty: MINT, memo: "gm <bakers> & friends", signature: "5".repeat(88) })],
  ["activity swap", ui.activityCard({ kind: "swap", address: ADDR, label: null, lines: [{ text: "−1,000 COOK", usd: "$0.07" }, { text: "+759.4 bCOOK", usd: "$0.07" }], counterparty: null, memo: null, signature: "5".repeat(88) })],
  ["linked", ui.linkedCard(wallet, false)],
  ["settings", ui.settingsCard(wallet, [w, { ...w, label: null }], [alert, { ...alert, id: 43, direction: "below" }])],
  ["settings empty", ui.settingsCard(null, [], [])],
  ["tip amount", ui.tipAmountPicker("cookie.cook")],
  ["tip pending", ui.tipCard(tip("pending"), 0.0000703)],
  ["tip paid", ui.tipCard(tip("paid"), 0.0000703)],
  ["tip expired", ui.tipCard(tip("expired"), null)],
  ["tip cancelled", ui.tipCard(tip("cancelled"), null)],
  ["tip usage", ui.tipUsage()],
  ["tip needs link", ui.tipNeedsLink("@bob", "pechenietest_bot")],
  ["quick actions", ui.quickActions(ADDR, "cookie.cook")],
  ["stopped", ui.stoppedCard("Treasury", ADDR)],
  ["send", ui.sendCard(ADDR, "cookie.cook", 250, 0.0000703)],
];

const ALLOWED = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);
let problems = 0;
const problem = (name: string, msg: string) => {
  problems++;
  console.log(`✘ ${name}: ${msg}`);
};

for (const [name, c] of cards) {
  if (c.text.length > 4096) problem(name, `text is ${c.text.length} chars`);
  // Tags must be allowed and balanced; bare < or & outside entities would be rejected.
  const stack: string[] = [];
  for (const m of c.text.matchAll(/<\/?([a-z-]+)(\s[^>]*)?>|<|&(?!(?:amp|lt|gt|quot);)/g)) {
    if (!m[1]) {
      problem(name, `unescaped "${m[0]}" at ${m.index}`);
      continue;
    }
    if (!ALLOWED.has(m[1])) problem(name, `tag <${m[1]}> not allowed`);
    if (m[0].startsWith("</")) {
      if (stack.pop() !== m[1]) problem(name, `unbalanced </${m[1]}>`);
    } else stack.push(m[1]);
  }
  if (stack.length) problem(name, `unclosed ${stack.join(",")}`);

  const buttons: InlineKeyboardButton[] = c.reply_markup?.inline_keyboard.flat() ?? [];
  for (const b of buttons) {
    if (b.text.length > 64 || !b.text.trim()) problem(name, `button text "${b.text}"`);
    if ("callback_data" in b && Buffer.byteLength(b.callback_data) > 64) problem(name, `callback_data ${Buffer.byteLength(b.callback_data)} bytes: ${b.callback_data}`);
    if ("url" in b && !/^(https:|tg:)/.test(b.url)) problem(name, `url button "${b.text}" is not https (${b.url.slice(0, 40)})`);
    if ("copy_text" in b && b.copy_text.text.length > 256) problem(name, "copy_text over 256");
  }
  for (const row of c.reply_markup?.inline_keyboard ?? []) if (row.length > 8) problem(name, `row with ${row.length} buttons`);

  if (process.argv.includes("--print")) {
    const plain = c.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const kb = (c.reply_markup?.inline_keyboard ?? []).map((r) => r.map((b) => `[${b.text}]`).join(" ")).join("\n");
    console.log(`\n── ${name} ──\n${plain}${kb ? `\n${kb}` : ""}`);
  }
}

console.log(`\n${cards.length} cards checked, ${problems} problem${problems === 1 ? "" : "s"}`);
process.exit(problems ? 1 : 0);
