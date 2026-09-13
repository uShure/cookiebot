// Every message the bot sends is built here: one visual grammar for the whole bot.
// Line 1 says what happened, line 2 carries the number that matters, details follow, actions are buttons.
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";

import { COOK_MINT, type Portfolio, type TokenInfo } from "./chain.js";
import { config } from "./config.js";
import { escapeHtml as e, explorerAddress, explorerToken, explorerTx, fmtAmount, fmtPrice, fmtUsd, shortAddr, utcTime } from "./format.js";
import type { PriceAlert, Tip, UserWallet, Watch } from "./store.js";

export const TIP_TTL_MINUTES = 60;

type Style = "primary" | "success" | "danger";

export interface Card {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

const withStyle = <T extends object>(b: T, style?: Style) => (style ? { ...b, style } : b);
export const cb = (text: string, data: string, style?: Style): InlineKeyboardButton => withStyle({ text, callback_data: data }, style);
export const link = (text: string, url: string, style?: Style): InlineKeyboardButton => withStyle({ text, url }, style);
const copy = (text: string, value: string): InlineKeyboardButton => ({ text, copy_text: { text: value.slice(0, 256) } });

// Telegram rejects non-https URL buttons, so without a public web app those buttons are dropped.
const webReady = config.webAppUrl.startsWith("https://");
export const webUrl = (params: Record<string, string> = {}) => `${config.webAppUrl}/?${new URLSearchParams(params)}`;
const webButton = (text: string, params: Record<string, string>, style?: Style) => (webReady ? [link(text, webUrl(params), style)] : []);

function card(lines: (string | false | null | undefined)[], rows: InlineKeyboardButton[][] = []): Card {
  const text = lines.filter((l) => l !== false && l != null).join("\n");
  const keyboard = rows.filter((r) => r.length);
  return keyboard.length ? { text, reply_markup: { inline_keyboard: keyboard } } : { text };
}

const nameOf = (w: { name?: string | null; label?: string | null; address: string }) => w.label ?? w.name ?? shortAddr(w.address);
const arrow = (pct: number | null) => (pct == null || !Number.isFinite(pct) ? "" : pct > 0 ? `↑ ${pct.toFixed(1)}%` : pct < 0 ? `↓ ${Math.abs(pct).toFixed(1)}%` : "flat");

// --- Home and help -------------------------------------------------------------------------------

export function home(wallet: UserWallet | null, cook: number | null, isGroup: boolean): Card {
  if (isGroup) {
    return card(
      [
        "<b>CookieBot</b> is in this group.",
        "",
        "Reply to someone with <code>/tip 500</code> to send them COOK.",
        "<code>/watch name.cook</code> posts every move of that wallet here.",
        "<code>/price bCOOK</code> shows a live price card.",
      ],
      [[cb("📊 Market", "mk:0"), cb("Commands", "help")]],
    );
  }
  return card(
    [
      "<b>CookieBot</b>",
      "Cookie Chain, in your chats.",
      "",
      "Get a message the moment a wallet moves, set price alerts, and tip people in COOK. You sign in Nightly; the bot never holds keys.",
      wallet && "",
      wallet && `Your wallet  <code>${e(nameOf(wallet))}</code>${cook != null ? `  ·  ${fmtAmount(cook)} COOK` : ""}`,
    ],
    [
      [cb("👀 Watch a wallet", "w:new"), cb("🔔 Price alert", "al:new")],
      [cb("💼 Portfolio", wallet ? `pf:${wallet.address}` : "pf:ask"), cb("📊 Market", "mk:0")],
      [cb("🍪 Tip someone", "tip:new")],
      [wallet ? cb("⚙️ Settings", "st") : cb("🔗 Link my wallet", "lk:new", "primary")],
      webButton("Open the app ↗", {}),
    ],
  );
}

export function help(): Card {
  return card(
    [
      "<b>Commands</b>",
      "",
      "<b>Wallets</b>",
      "/watch <i>name.cook</i> — message on every transfer",
      "/portfolio <i>name.cook</i> — balances in USD",
      "/link <i>name.cook</i> — set your own wallet",
      "",
      "<b>Prices</b>",
      "/price <i>bCOOK</i> — live price card",
      "/alert <i>bCOOK above 0.0001</i> — one-time alert",
      "/top — deepest COOK pairs",
      "",
      "<b>Tips</b>",
      "/tip <i>500</i> — as a reply to someone’s message",
      "/tip <i>@user 500</i> or /tip <i>name.cook 500</i>",
      "",
      "/settings — everything you’re watching, in one place",
    ],
    [[cb("‹ Menu", "m")]],
  );
}

export const errorCard = (message: string, retry?: InlineKeyboardButton): Card => card([`⚠️ ${e(message)}`], retry ? [[retry]] : []);

// --- Prompts (sent with ForceReply) --------------------------------------------------------------

export const prompts = {
  watch: { text: "👀 <b>Which wallet should I watch?</b>\nSend an address or a .cook name.", placeholder: "name.cook or address" },
  portfolio: { text: "💼 <b>Whose portfolio?</b>\nSend an address or a .cook name.", placeholder: "name.cook or address" },
  link: {
    text: "🔗 <b>Link your wallet</b>\nSend your address or .cook name. People can then tip you by replying to your messages, and Portfolio opens your wallet in one tap.",
    placeholder: "name.cook or address",
  },
  rename: { text: "✏️ <b>New name for this wallet?</b>\nUp to 24 characters.", placeholder: "Treasury" },
  alertToken: { text: "🔔 <b>Which token?</b>\nSend its symbol or mint address.", placeholder: "bCOOK" },
  alertPrice: (symbol: string, now: number | null) => ({
    text: `🔔 <b>${e(symbol)}</b> is at ${fmtPrice(now)}.\nSend the price in USD that should trigger the alert.`,
    placeholder: now ? String(Number(now.toPrecision(3))) : "0.0001",
  }),
  tipTo: { text: "🍪 <b>Who gets the tip?</b>\nSend a .cook name, an address or a @username that linked a wallet.", placeholder: "name.cook" },
  tipAmount: { text: "🍪 <b>How much COOK?</b>", placeholder: "500" },
};

// --- Prices --------------------------------------------------------------------------------------

export function priceCard(t: TokenInfo, updated = new Date()): Card {
  const isCook = t.mint === COOK_MINT;
  return card(
    [
      `<b>${e(t.symbol)}</b>${t.name && t.name.toLowerCase() !== t.symbol.toLowerCase() ? `  <i>${e(t.name)}</i>` : ""}`,
      `<b>${fmtPrice(t.priceUsd)}</b>   ${arrow(t.change24h)}${t.change24h != null ? " <i>24h</i>" : ""}`,
      "",
      `${fmtAmount(t.holders)} holders  ·  ${fmtAmount(t.liquidityCook)} COOK liquidity`,
      `<code>${t.mint}</code>`,
      `<i>Updated ${utcTime(updated)}</i>`,
    ],
    [
      [cb("↻ Refresh", `pr:r:${t.mint}`), cb("🔔 Alert", `al:T:${t.mint}`)],
      [...(isCook ? [] : webButton("Swap ↗", { swap: t.mint })), link("Cookiescan ↗", explorerToken(t.mint))],
    ],
  );
}

export const MARKET_PAGE = 8;

export function marketCard(tokens: TokenInfo[], page: number, updated = new Date()): Card {
  const pages = Math.max(1, Math.ceil(tokens.length / MARKET_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = tokens.slice(p * MARKET_PAGE, (p + 1) * MARKET_PAGE);
  const lines = slice.map((t, i) => `<code>${String(p * MARKET_PAGE + i + 1).padStart(2, " ")}</code>  <b>${e(t.symbol)}</b>  ${fmtPrice(t.priceUsd)}  <i>${arrow(t.change24h)}</i>`);
  const numbers = slice.map((t, i) => cb(String(p * MARKET_PAGE + i + 1), `pr:${t.mint}`));
  return card(
    ["📊 <b>Market</b>  ·  deepest COOK pairs", "", ...lines, "", `<i>Tap a number for its price card · ${utcTime(updated)}</i>`],
    [
      numbers.slice(0, 4),
      numbers.slice(4, 8),
      [...(p > 0 ? [cb("‹ Prev", `mk:${p - 1}`)] : []), cb("↻", `mk:${p}`), ...(p < pages - 1 ? [cb("Next ›", `mk:${p + 1}`)] : [])],
    ],
  );
}

// --- Alerts --------------------------------------------------------------------------------------

export function alertPicker(tokens: TokenInfo[]): Card {
  const picks = tokens.slice(0, 6).map((t) => cb(t.symbol, `al:t:${t.mint}`));
  return card(
    ["🔔 <b>New price alert</b>", "Pick a token, or send its symbol."],
    [[cb("COOK", `al:t:${COOK_MINT}`), ...picks.slice(0, 2)], picks.slice(2, 5), [cb("Other token…", "al:other"), cb("‹ Menu", "m")]],
  );
}

export function alertPresets(t: TokenInfo): Card {
  const m = t.mint;
  return card(
    [`🔔 <b>${e(t.symbol)}</b> is at <b>${fmtPrice(t.priceUsd)}</b>`, "Message me once it goes…"],
    [
      [cb("↑ +10%", `al:p:${m}:u:10`), cb("↑ +25%", `al:p:${m}:u:25`), cb("↑ +50%", `al:p:${m}:u:50`)],
      [cb("↓ −10%", `al:p:${m}:d:10`), cb("↓ −25%", `al:p:${m}:d:25`), cb("↓ −50%", `al:p:${m}:d:50`)],
      [cb("Exact price…", `al:c:${m}`), cb("‹ Back", "al:new")],
    ],
  );
}

export function alertSet(a: PriceAlert, now: number | null): Card {
  return card(
    [
      "✅ <b>Alert set</b>",
      `${e(a.symbol)} ${a.direction} <b>${fmtPrice(a.target)}</b>`,
      `<i>Now ${fmtPrice(now)}. It fires once, then removes itself.</i>`,
    ],
    [[cb("Delete", `al:rm:${a.id}`, "danger"), cb("All alerts", "st")]],
  );
}

export function alertFired(a: PriceAlert, price: number): Card {
  return card(
    [
      `🔔 <b>${e(a.symbol)} ${a.direction === "above" ? "crossed above" : "dropped below"} ${fmtPrice(a.target)}</b>`,
      `Now <b>${fmtPrice(price)}</b>`,
    ],
    [[cb("Price card", `pr:${a.mint}`), cb("Set another", `al:T:${a.mint}`)], a.mint === COOK_MINT ? [] : webButton("Swap ↗", { swap: a.mint })],
  );
}

// --- Wallets -------------------------------------------------------------------------------------

export function watchingCard(w: Watch, state: "new" | "exists" | "renamed"): Card {
  const title = { new: "Watching", exists: "Already watching", renamed: "Renamed to" }[state];
  return card(
    [
      `👀 <b>${title} ${e(nameOf(w))}</b>`,
      `<code>${w.address}</code>`,
      state === "new" && "<i>Every transfer lands in this chat within seconds.</i>",
    ],
    [
      [cb("✏️ Rename", `w:rn:${w.address}`), cb("💼 Portfolio", `pf:${w.address}`)],
      [cb("Stop watching", `w:rm:${w.address}`, "danger")],
    ],
  );
}

export function portfolioCard(address: string, name: string | null, p: Portfolio, watched: boolean, updated = new Date()): Card {
  const top = p.tokens.slice(0, 5);
  const rest = p.tokens.slice(5, 40);
  const row = (t: { symbol: string; amount: number; usd: number | null }) => `${e(t.symbol)}  ${fmtAmount(t.amount)}  <i>${fmtUsd(t.usd)}</i>`;
  return card(
    [
      `💼 <b>${e(name ?? shortAddr(address))}</b>`,
      `<b>${fmtUsd(p.totalUsd)}</b> total`,
      "",
      `COOK  ${fmtAmount(p.cook)}  <i>${fmtUsd(p.cookUsd)}</i>`,
      ...top.map(row),
      rest.length > 0 && `<blockquote expandable>${rest.map(row).join("\n")}${p.tokens.length > 40 ? `\n…and ${p.tokens.length - 40} more` : ""}</blockquote>`,
      `<i>Updated ${utcTime(updated)}</i>`,
    ],
    [
      [cb("↻ Refresh", `pf:r:${address}`), watched ? cb("✏️ Rename", `w:rn:${address}`) : cb("👀 Watch", `w:add:${address}`)],
      [link("Cookiescan ↗", explorerAddress(address)), copy("Copy address", address)],
    ],
  );
}

export interface ActivityLine {
  text: string;
  usd: string | null;
}

export function activityCard(opts: {
  kind: "received" | "sent" | "swap" | "failed" | "activity";
  address: string;
  label: string | null;
  lines: ActivityLine[];
  counterparty: string | null;
  memo: string | null;
  signature: string;
}): Card {
  const title = { received: "📥 Received", sent: "📤 Sent", swap: "🔁 Swapped", failed: "⚠️ Failed transaction", activity: "🔄 Activity" }[opts.kind];
  const party = opts.counterparty ? `${opts.kind === "sent" ? "to" : "from"} <code>${shortAddr(opts.counterparty)}</code>` : null;
  return card(
    [
      `<b>${title}</b>  ·  ${e(opts.label ?? shortAddr(opts.address))}`,
      ...opts.lines.map((l) => `<b>${e(l.text)}</b>${l.usd ? `  <i>≈ ${l.usd}</i>` : ""}`),
      opts.kind !== "swap" && party,
      opts.memo && `<blockquote>${e(opts.memo.slice(0, 300))}</blockquote>`,
    ],
    [[link("Receipt ↗", explorerTx(opts.signature)), cb("💼 Portfolio", `pf:${opts.address}`), cb("🔕 Stop", `w:rm:${opts.address}`)]],
  );
}

export function linkedCard(wallet: UserWallet, watched: boolean): Card {
  const handle = wallet.username ? `@${e(wallet.username)}` : "your username";
  return card(
    [
      "🔗 <b>Wallet linked</b>",
      `<code>${e(nameOf(wallet))}</code>`,
      "",
      `People can now tip you with <code>/tip ${handle} 500</code> or by replying to your message with <code>/tip 500</code>.`,
    ],
    [[cb("💼 Portfolio", `pf:${wallet.address}`), watched ? cb("‹ Menu", "m") : cb("👀 Watch it too", `w:add:${wallet.address}`)]],
  );
}

export function settingsCard(wallet: UserWallet | null, watches: Watch[], alerts: PriceAlert[]): Card {
  const empty = !watches.length && !alerts.length;
  return card(
    [
      "⚙️ <b>Settings</b>",
      wallet ? `Your wallet  <code>${e(nameOf(wallet))}</code>` : "No wallet linked yet.",
      `Watching ${watches.length} ${watches.length === 1 ? "wallet" : "wallets"}  ·  ${alerts.length} price ${alerts.length === 1 ? "alert" : "alerts"}`,
      !empty && "<i>Tap an item to remove it.</i>",
    ],
    [
      ...watches.slice(0, 8).map((w) => [cb(`✕  👀 ${nameOf(w)}`, `w:rm:${w.address}`)]),
      ...alerts.slice(0, 8).map((a) => [cb(`✕  🔔 ${a.symbol} ${a.direction === "above" ? "↑" : "↓"} ${fmtPrice(a.target)}`, `al:rm:${a.id}`)]),
      wallet ? [cb("🔗 Change wallet", "lk:new"), cb("Unlink", "lk:rm", "danger")] : [cb("🔗 Link my wallet", "lk:new", "primary")],
      [cb("‹ Menu", "m")],
    ],
  );
}

// --- Tips ----------------------------------------------------------------------------------------

export function tipAmountPicker(toLabel: string): Card {
  return card(
    [`🍪 <b>Tip ${e(toLabel)}</b>`, "How much COOK?"],
    [[cb("100", "tip:a:100"), cb("500", "tip:a:500"), cb("1K", "tip:a:1000"), cb("5K", "tip:a:5000")], [cb("Other amount…", "tip:a:custom"), cb("Cancel", "m")]],
  );
}

export function tipCard(tip: Tip, cookUsd: number | null): Card {
  const usd = cookUsd != null ? `  <i>≈ ${fmtUsd(tip.amount * cookUsd)}</i>` : "";
  const amount = `<b>${fmtAmount(tip.amount)} COOK</b>${usd}`;
  const from = e(tip.from_name);
  const to = e(tip.to_label);
  switch (tip.status) {
    case "paid":
      return card(
        [`✅ <b>${from} tipped ${to}</b>`, amount, "<i>Confirmed on Cookie Chain</i>"],
        tip.signature ? [[link("Receipt ↗", explorerTx(tip.signature))]] : [],
      );
    case "expired":
      return card([`⌛ <b>Tip expired</b>`, `${from} → ${to}  ·  ${fmtAmount(tip.amount)} COOK`, "<i>Not paid within an hour.</i>"]);
    case "cancelled":
      return card([`<b>Tip cancelled</b>`, `${from} → ${to}  ·  ${fmtAmount(tip.amount)} COOK`]);
    default:
      return card(
        [`🍪 <b>${from} → ${to}</b>`, amount, `<i>Waiting for the payment · open for ${TIP_TTL_MINUTES} min</i>`],
        [
          webButton("Pay with Nightly ↗", { to: tip.to_address, amount: String(tip.amount), label: tip.to_label, memo: `cookiebot:tip:${tip.id}` }, "success"),
          [cb("Cancel", `tip:x:${tip.id}`)],
        ],
      );
  }
}

export function tipUsage(): Card {
  return card([
    "🍪 <b>Tipping in a group</b>",
    "Reply to someone’s message with <code>/tip 500</code>,",
    "or use <code>/tip @username 500</code> or <code>/tip name.cook 500</code>.",
  ]);
}

export function tipNeedsLink(who: string, botUsername: string): Card {
  return card(
    [`🍪 <b>${e(who)} hasn’t linked a wallet yet</b>`, "Once they link one, replies with /tip work for them."],
    [[link("Link a wallet ↗", `https://t.me/${botUsername}?start=link`, "primary")]],
  );
}

export function quickActions(address: string, name: string | null): Card {
  return card(
    [`<b>${e(name ?? shortAddr(address))}</b>`, `<code>${address}</code>`, "What should I do with it?"],
    [
      [cb("👀 Watch", `q:w:${address}`), cb("💼 Portfolio", `q:p:${address}`)],
      [cb("🍪 Tip", `q:t:${address}`), cb("🔗 It’s my wallet", `q:l:${address}`)],
    ],
  );
}

export const noticeCard = (text: string): Card => card([e(text)]);

export function stoppedCard(label: string, address: string): Card {
  return card([`<b>Stopped watching ${e(label)}</b>`, `<code>${address}</code>`], [[cb("Watch again", `w:add:${address}`)]]);
}

export function sendCard(toAddress: string, toLabel: string, amount: number, cookUsd: number | null): Card {
  return card(
    [`📤 <b>Send ${fmtAmount(amount)} COOK</b> to ${e(toLabel)}`, cookUsd != null ? `<i>≈ ${fmtUsd(amount * cookUsd)}</i>` : null, `<code>${toAddress}</code>`],
    [webButton("Sign in Nightly ↗", { to: toAddress, amount: String(amount), label: toLabel }, "success")],
  );
}
