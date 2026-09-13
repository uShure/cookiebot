import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";

import { findToken, getPortfolio, resolveWallet, topTokens, COOK_MINT } from "./chain.js";
import { botToken, config } from "./config.js";
import { escapeHtml, explorerAddress, explorerToken, fmtAmount, fmtChange, fmtPrice, fmtUsd, shortAddr } from "./format.js";
import * as store from "./store.js";
import { startWatchers, syncWalletSubscriptions, tipMemo } from "./watcher.js";

const bot = new Bot(botToken());
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
// Telegram rejects non-https URL buttons, so local dev falls back to plain links in the text.
const canButton = config.webAppUrl.startsWith("https://");

function webUrl(params: Record<string, string>): string {
  return `${config.webAppUrl}/?${new URLSearchParams(params)}`;
}

function withLink(text: string, label: string, url: string, keyboard = new InlineKeyboard()) {
  if (canButton) return { text, keyboard: keyboard.url(label, url) };
  return { text: `${text}\n\n${label}: ${url}`, keyboard };
}

function args(ctx: Context): string[] {
  return (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
}

async function reply(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  return ctx.reply(text, { ...HTML, ...(keyboard?.inline_keyboard.length ? { reply_markup: keyboard } : {}) });
}

const HELP = [
  "🍪 <b>CookieBot</b> — Cookie Chain in your Telegram",
  "",
  "<b>Market</b>",
  "/price <code>SYMBOL</code> — price, 24h change, holders",
  "/top — deepest tokens by liquidity",
  "",
  "<b>Wallets</b>",
  "/portfolio <code>address|name.cook</code> — balances in USD",
  "/watch <code>address|name.cook [label]</code> — live alerts on every move",
  "/unwatch <code>address|name.cook</code>  ·  /watches",
  "",
  "<b>Alerts</b>",
  "/alert <code>SYMBOL above|below PRICE</code> — e.g. <code>/alert bCOOK above 0.0001</code>",
  "/alerts  ·  /delalert <code>ID</code>",
  "",
  "<b>Pay</b> (signed in your Nightly wallet)",
  "/tip <code>name.cook AMOUNT</code> — tip in COOK, confirmed live in chat",
  "/send <code>address|name.cook AMOUNT</code>",
  "/swap <code>SYMBOL</code> — swap COOK via Cookiebox",
].join("\n");

bot.command(["start", "help"], async (ctx) => {
  const payload = args(ctx)[0] ?? "";
  if (payload.startsWith("watch_") && ctx.chat) {
    const address = payload.slice("watch_".length);
    try {
      const w = await resolveWallet(address);
      const added = store.addWatch(ctx.chat.id, w.address, w.name);
      await syncWalletSubscriptions(ctx.api);
      await reply(ctx, `${added ? "👀 Watching" : "Already watching"} <code>${w.address}</code>. You'll get a message on every transfer.`);
    } catch (e) {
      await reply(ctx, `⚠️ ${escapeHtml((e as Error).message)}`);
    }
  }
  const { text, keyboard } = withLink(HELP, "🍪 Open CookieBot app", webUrl({}));
  await reply(ctx, text, keyboard);
});

bot.command("price", async (ctx) => {
  const [q] = args(ctx);
  if (!q) return reply(ctx, "Usage: /price <code>SYMBOL</code> or mint, e.g. <code>/price bCOOK</code>");
  const t = await findToken(q);
  if (!t) return reply(ctx, `No token found for <code>${escapeHtml(q)}</code>. Try /top.`);
  const lines = [
    `🍪 <b>${escapeHtml(t.symbol)}</b>${t.name ? ` · ${escapeHtml(t.name)}` : ""}`,
    `Price: <b>${fmtPrice(t.priceUsd)}</b> ${fmtChange(t.change24h)}`,
    `Holders: ${fmtAmount(t.holders)} · Liquidity: ${fmtAmount(t.liquidityCook)} COOK`,
    `<code>${t.mint}</code>`,
  ];
  const kb = new InlineKeyboard();
  if (t.mint !== COOK_MINT && canButton) kb.url("🔄 Swap", webUrl({ swap: t.mint }));
  kb.url("Cookiescan", explorerToken(t.mint));
  await reply(ctx, lines.join("\n"), kb);
});

bot.command("top", async (ctx) => {
  const tokens = await topTokens(10);
  const lines = tokens.map((t, i) => `${i + 1}. <b>${escapeHtml(t.symbol)}</b> ${fmtPrice(t.priceUsd)} ${fmtChange(t.change24h)} · liq ${fmtAmount(t.liquidityCook)} COOK`);
  await reply(ctx, ["🏆 <b>Top Cookie Chain tokens by liquidity</b>", "", ...lines].join("\n"));
});

bot.command("portfolio", async (ctx) => {
  let [target] = args(ctx);
  if (!target && ctx.chat) target = store.watchesForChat(ctx.chat.id)[0]?.address;
  if (!target) return reply(ctx, "Usage: /portfolio <code>address|name.cook</code>");
  try {
    const w = await resolveWallet(target);
    const p = await getPortfolio(w.address);
    const lines = [
      `💼 <b>${escapeHtml(w.name ?? shortAddr(w.address))}</b> · total <b>${fmtUsd(p.totalUsd)}</b>`,
      `COOK: ${fmtAmount(p.cook)} (${fmtUsd(p.cookUsd)})`,
      ...p.tokens.slice(0, 15).map((t) => `${escapeHtml(t.symbol)}: ${fmtAmount(t.amount)} (${fmtUsd(t.usd)})`),
    ];
    if (p.tokens.length > 15) lines.push(`…and ${p.tokens.length - 15} more`);
    await reply(ctx, lines.join("\n"), new InlineKeyboard().url("Cookiescan", explorerAddress(w.address)));
  } catch (e) {
    await reply(ctx, `⚠️ ${escapeHtml((e as Error).message)}`);
  }
});

bot.command("watch", async (ctx) => {
  const [target, ...labelParts] = args(ctx);
  if (!target || !ctx.chat) return reply(ctx, "Usage: /watch <code>address|name.cook [label]</code>");
  try {
    const w = await resolveWallet(target);
    const label = labelParts.join(" ").slice(0, 40) || w.name;
    const added = store.addWatch(ctx.chat.id, w.address, label);
    await syncWalletSubscriptions(ctx.api);
    await reply(ctx, added
      ? `👀 Watching <b>${escapeHtml(label ?? shortAddr(w.address))}</b>. Every transfer will land here within seconds.`
      : "Already watching that wallet here.");
  } catch (e) {
    await reply(ctx, `⚠️ ${escapeHtml((e as Error).message)}`);
  }
});

bot.command("unwatch", async (ctx) => {
  const [target] = args(ctx);
  if (!target || !ctx.chat) return reply(ctx, "Usage: /unwatch <code>address|name.cook</code>");
  try {
    const w = await resolveWallet(target);
    const removed = store.removeWatch(ctx.chat.id, w.address);
    await syncWalletSubscriptions(ctx.api);
    await reply(ctx, removed ? "Stopped watching." : "That wallet isn't watched here.");
  } catch (e) {
    await reply(ctx, `⚠️ ${escapeHtml((e as Error).message)}`);
  }
});

bot.command("watches", async (ctx) => {
  if (!ctx.chat) return;
  const list = store.watchesForChat(ctx.chat.id);
  if (!list.length) return reply(ctx, "No watched wallets. Add one with /watch.");
  await reply(ctx, ["👀 <b>Watched wallets</b>", ...list.map((w) => `• ${escapeHtml(w.label ?? "")} <code>${w.address}</code>`)].join("\n"));
});

bot.command("alert", async (ctx) => {
  const [q, dir, priceStr] = args(ctx);
  const target = Number(priceStr);
  if (!q || (dir !== "above" && dir !== "below") || !(target > 0) || !ctx.chat) {
    return reply(ctx, "Usage: /alert <code>SYMBOL above|below PRICE</code>\nExample: <code>/alert COOK above 0.0001</code>");
  }
  const t = await findToken(q);
  if (!t) return reply(ctx, `No token found for <code>${escapeHtml(q)}</code>.`);
  const id = store.addPriceAlert({ chat_id: ctx.chat.id, mint: t.mint, symbol: t.symbol, direction: dir, target });
  await reply(ctx, `🔔 Alert #${id}: <b>${escapeHtml(t.symbol)}</b> ${dir} ${fmtPrice(target)} (now ${fmtPrice(t.priceUsd)})`);
});

bot.command("alerts", async (ctx) => {
  if (!ctx.chat) return;
  const list = store.priceAlertsForChat(ctx.chat.id);
  if (!list.length) return reply(ctx, "No price alerts. Add one with /alert.");
  await reply(ctx, ["🔔 <b>Price alerts</b>", ...list.map((a) => `#${a.id} ${escapeHtml(a.symbol)} ${a.direction} ${fmtPrice(a.target)}`)].join("\n"));
});

bot.command("delalert", async (ctx) => {
  const id = Number(args(ctx)[0]);
  if (!ctx.chat || !Number.isInteger(id)) return reply(ctx, "Usage: /delalert <code>ID</code>");
  await reply(ctx, store.deletePriceAlert(id, ctx.chat.id) ? `Deleted alert #${id}.` : "No such alert in this chat.");
});

async function paymentCommand(ctx: Context, kind: "tip" | "send") {
  const [target, amountStr] = args(ctx);
  const amount = Number(amountStr);
  if (!target || !(amount > 0) || !ctx.chat) {
    return reply(ctx, `Usage: /${kind} <code>address|name.cook AMOUNT</code>`);
  }
  try {
    const w = await resolveWallet(target);
    const toLabel = w.name ?? shortAddr(w.address);
    if (kind === "send") {
      const { text, keyboard } = withLink(
        `💸 Send <b>${fmtAmount(amount)} COOK</b> to ${escapeHtml(toLabel)}`,
        "Sign with Nightly",
        webUrl({ to: w.address, amount: String(amount), label: toLabel }),
      );
      return reply(ctx, text, keyboard);
    }
    const id = randomBytes(5).toString("hex");
    const fromName = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "someone");
    store.createTip({ id, chat_id: ctx.chat.id, from_name: fromName, to_address: w.address, to_label: toLabel, amount });
    const { text, keyboard } = withLink(
      `🍪 <b>${escapeHtml(fromName)}</b> wants to tip <b>${fmtAmount(amount)} COOK</b> to ${escapeHtml(toLabel)}\n⏳ Waiting for the on-chain payment…`,
      "Pay with Nightly",
      webUrl({ to: w.address, amount: String(amount), label: toLabel, memo: tipMemo(id) }),
    );
    const msg = await reply(ctx, text, keyboard);
    store.setTipMessage(id, msg.message_id);
  } catch (e) {
    await reply(ctx, `⚠️ ${escapeHtml((e as Error).message)}`);
  }
}

bot.command("tip", (ctx) => paymentCommand(ctx, "tip"));
bot.command("send", (ctx) => paymentCommand(ctx, "send"));

bot.command("swap", async (ctx) => {
  const [q] = args(ctx);
  const t = q ? await findToken(q) : null;
  if (!t || t.mint === COOK_MINT) return reply(ctx, "Usage: /swap <code>SYMBOL</code>, e.g. <code>/swap bCOOK</code>");
  const { text, keyboard } = withLink(
    `🔄 Swap COOK → <b>${escapeHtml(t.symbol)}</b> at ${fmtPrice(t.priceUsd)} via the Cookiebox aggregator`,
    "Open swap",
    webUrl({ swap: t.mint }),
  );
  await reply(ctx, text, keyboard);
});

bot.catch((err) => console.error("[bot]", err.error));

await bot.api.setMyCommands([
  { command: "price", description: "Token price and 24h change" },
  { command: "top", description: "Top tokens by liquidity" },
  { command: "portfolio", description: "Wallet balances in USD" },
  { command: "watch", description: "Live alerts for a wallet" },
  { command: "watches", description: "List watched wallets" },
  { command: "alert", description: "Price alert above/below" },
  { command: "alerts", description: "List price alerts" },
  { command: "tip", description: "Tip COOK, confirmed in chat" },
  { command: "send", description: "Send COOK with Nightly" },
  { command: "swap", description: "Swap COOK via Cookiebox" },
  { command: "help", description: "All commands" },
]);
await startWatchers(bot.api);
console.log("[bot] CookieBot is running");
await bot.start({ drop_pending_updates: true });
