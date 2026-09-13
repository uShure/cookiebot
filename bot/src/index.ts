import { randomBytes } from "node:crypto";

import { Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup, InlineQueryResultArticle } from "grammy/types";

import { COOK_MINT, connection, findToken, getCookPriceUsd, getPortfolio, looksLikeName, resolveWallet, topTokens } from "./chain.js";
import { botToken } from "./config.js";
import { escapeHtml, fmtAmount, fmtPrice, parseAmount, parsePrice, shortAddr } from "./format.js";
import * as store from "./store.js";
import * as ui from "./ui.js";
import { refreshTipMessage, startWatchers, syncWalletSubscriptions } from "./watcher.js";

const bot = new Bot(botToken());
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

// --- sending helpers -----------------------------------------------------------------------------

const markup = (c: ui.Card) => (c.reply_markup ? { reply_markup: c.reply_markup } : {});

async function reply(ctx: Context, c: ui.Card) {
  return ctx.reply(c.text, { ...HTML, ...markup(c) });
}

/** Edit the message the button belongs to; fall back to a new message when it can't be edited. */
async function replace(ctx: Context, c: ui.Card) {
  try {
    await ctx.editMessageText(c.text, { ...HTML, reply_markup: c.reply_markup ?? { inline_keyboard: [] } });
  } catch (e) {
    if (/not modified/i.test(String((e as Error).message))) return;
    await reply(ctx, c);
  }
}

const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
const displayName = (ctx: Context) => (ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? "Someone"));
const words = (ctx: Context) => (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
const typing = (ctx: Context) => ctx.replyWithChatAction("typing").catch(() => {});

// --- pending input (ForceReply flows) ------------------------------------------------------------

type Pending =
  | { kind: "watch" | "portfolio" | "link" | "alertToken" | "tipTo" }
  | { kind: "rename"; address: string }
  | { kind: "alertPrice"; mint: string }
  | { kind: "tipAmount"; toAddress: string; toLabel: string };

const pending = new Map<string, { p: Pending; promptId: number; at: number }>();
const PENDING_TTL_MS = 15 * 60_000;
const pendingKey = (ctx: Context) => `${ctx.chat?.id}:${ctx.from?.id}`;

async function ask(ctx: Context, p: Pending, prompt: { text: string; placeholder: string }) {
  // In groups, mention the user so ForceReply(selective) targets only them.
  const who = isGroup(ctx) && ctx.from ? `<a href="tg://user?id=${ctx.from.id}">${escapeHtml(ctx.from.first_name)}</a>, ` : "";
  const msg = await ctx.reply(`${who}${prompt.text}`, {
    ...HTML,
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: prompt.placeholder.slice(0, 64) },
  });
  pending.set(pendingKey(ctx), { p, promptId: msg.message_id, at: Date.now() });
}

function setPending(ctx: Context, p: Pending, promptId: number) {
  pending.set(pendingKey(ctx), { p, promptId, at: Date.now() });
}

// --- recipients ----------------------------------------------------------------------------------

interface Recipient {
  address: string;
  label: string;
}

async function resolveRecipient(input: string): Promise<Recipient> {
  const s = input.trim();
  if (s.startsWith("@")) {
    const w = store.walletOfUsername(s);
    if (!w) throw new Error(`${s} hasn’t linked a wallet yet. They can do it with /link in a private chat with me.`);
    return { address: w.address, label: s };
  }
  const w = await resolveWallet(s);
  return { address: w.address, label: w.name ?? shortAddr(w.address) };
}

// --- actions shared by commands, buttons and replies ---------------------------------------------

async function showHome(ctx: Context, edit = false) {
  const wallet = ctx.from ? store.walletOfUser(ctx.from.id) : null;
  const cook = wallet ? await connection.getBalance(new (await import("@solana/web3.js")).PublicKey(wallet.address)).then((l) => l / 1e9).catch(() => null) : null;
  const c = ui.home(wallet, cook, isGroup(ctx));
  return edit ? replace(ctx, c) : reply(ctx, c);
}

async function watch(ctx: Context, input: string, label?: string) {
  const w = await resolveWallet(input);
  const isNew = store.addWatch(ctx.chat!.id, w.address, label?.slice(0, 24) || w.name);
  await syncWalletSubscriptions(ctx.api);
  return reply(ctx, ui.watchingCard(store.getWatch(ctx.chat!.id, w.address)!, isNew ? "new" : "exists"));
}

async function portfolio(ctx: Context, address: string, name: string | null, edit = false) {
  await typing(ctx);
  const p = await getPortfolio(address);
  const c = ui.portfolioCard(address, name, p, Boolean(ctx.chat && store.getWatch(ctx.chat.id, address)));
  return edit ? replace(ctx, c) : reply(ctx, c);
}

async function priceOf(query: string) {
  const t = await findToken(query);
  if (!t) throw new Error(`No token called “${query}”. Try /top to see what’s trading.`);
  return t;
}

async function createAlert(ctx: Context, mint: string, target: number, direction?: "above" | "below", edit = false) {
  const t = await priceOf(mint === COOK_MINT ? "COOK" : mint);
  const dir = direction ?? (t.priceUsd != null && target < t.priceUsd ? "below" : "above");
  const id = store.addPriceAlert({ chat_id: ctx.chat!.id, mint: t.mint, symbol: t.symbol, direction: dir, target });
  const c = ui.alertSet({ id, chat_id: ctx.chat!.id, mint: t.mint, symbol: t.symbol, direction: dir, target }, t.priceUsd);
  return edit ? replace(ctx, c) : reply(ctx, c);
}

async function createTip(ctx: Context, to: Recipient, amount: number, editMessage = false) {
  const id = randomBytes(5).toString("hex");
  store.createTip({ id, chat_id: ctx.chat!.id, creator_id: ctx.from?.id ?? null, from_name: displayName(ctx), to_address: to.address, to_label: to.label, amount });
  const c = ui.tipCard(store.getTip(id)!, await getCookPriceUsd().catch(() => null));
  if (editMessage && ctx.callbackQuery?.message) {
    await replace(ctx, c);
    store.setTipMessage(id, ctx.callbackQuery.message.message_id);
  } else {
    const msg = await reply(ctx, c);
    store.setTipMessage(id, msg.message_id);
  }
}

async function settings(ctx: Context, edit = false) {
  const wallet = ctx.from ? store.walletOfUser(ctx.from.id) : null;
  const c = ui.settingsCard(isGroup(ctx) ? null : wallet, store.watchesForChat(ctx.chat!.id), store.priceAlertsForChat(ctx.chat!.id));
  return edit ? replace(ctx, c) : reply(ctx, c);
}

function fail(ctx: Context, e: unknown, retry?: ReturnType<typeof ui.cb>) {
  return reply(ctx, ui.errorCard((e as Error).message, retry));
}

// --- commands ------------------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.from) store.touchUsername(ctx.from.id, ctx.from.username);
  await next();
});

bot.command(["start", "menu"], async (ctx) => {
  const payload = words(ctx)[0] ?? "";
  const [action, arg] = payload.split("_");
  try {
    if ((action === "watch" || action === "link") && arg) {
      const w = await resolveWallet(arg);
      if (action === "link" && ctx.from && !isGroup(ctx)) {
        store.linkWallet(ctx.from.id, ctx.from.username, w.address, w.name);
        store.addWatch(ctx.chat.id, w.address, w.name ?? "My wallet");
        await syncWalletSubscriptions(ctx.api);
        return reply(ctx, ui.linkedCard(store.walletOfUser(ctx.from.id)!, true));
      }
      return watch(ctx, w.address);
    }
    if (action === "link" && !isGroup(ctx)) return ask(ctx, { kind: "link" }, ui.prompts.link);
  } catch (e) {
    return fail(ctx, e);
  }
  return showHome(ctx);
});

bot.command("help", (ctx) => reply(ctx, ui.help()));
bot.command(["settings", "watches", "alerts"], (ctx) => settings(ctx));
bot.command("top", async (ctx) => reply(ctx, ui.marketCard(await topTokens(40), 0)));

bot.command("price", async (ctx) => {
  const [q] = words(ctx);
  if (!q) return reply(ctx, ui.marketCard(await topTokens(40), 0));
  try {
    return reply(ctx, ui.priceCard(await priceOf(q)));
  } catch (e) {
    return fail(ctx, e);
  }
});

bot.command("swap", async (ctx) => {
  const [q] = words(ctx);
  if (!q) return reply(ctx, ui.marketCard(await topTokens(40), 0));
  try {
    return reply(ctx, ui.priceCard(await priceOf(q)));
  } catch (e) {
    return fail(ctx, e);
  }
});

bot.command("portfolio", async (ctx) => {
  const [q] = words(ctx);
  try {
    if (q) {
      const w = await resolveWallet(q);
      return portfolio(ctx, w.address, w.name);
    }
    const mine = ctx.from ? store.walletOfUser(ctx.from.id) : null;
    if (mine) return portfolio(ctx, mine.address, mine.name);
    return ask(ctx, { kind: "portfolio" }, ui.prompts.portfolio);
  } catch (e) {
    return fail(ctx, e, ui.cb("Try again", "pf:ask"));
  }
});

bot.command("watch", async (ctx) => {
  const [q, ...label] = words(ctx);
  if (!q) return ask(ctx, { kind: "watch" }, ui.prompts.watch);
  try {
    return await watch(ctx, q, label.join(" "));
  } catch (e) {
    return fail(ctx, e, ui.cb("Try again", "w:new"));
  }
});

bot.command("unwatch", async (ctx) => {
  const [q] = words(ctx);
  if (!q) return settings(ctx);
  try {
    const w = await resolveWallet(q);
    const removed = store.removeWatch(ctx.chat.id, w.address);
    await syncWalletSubscriptions(ctx.api);
    return reply(ctx, ui.errorCard(removed ? `Stopped watching ${w.name ?? shortAddr(w.address)}.` : "That wallet isn’t watched in this chat."));
  } catch (e) {
    return fail(ctx, e);
  }
});

bot.command("alert", async (ctx) => {
  const [q, dir, priceStr] = words(ctx);
  try {
    if (!q) return reply(ctx, ui.alertPicker(await topTokens(6)));
    const t = await priceOf(q);
    if (!dir) return reply(ctx, ui.alertPresets(t));
    const target = parsePrice(priceStr ?? "");
    if ((dir !== "above" && dir !== "below") || target == null) {
      return reply(ctx, ui.errorCard("Use it like /alert bCOOK above 0.0001 — or just /alert and tap."));
    }
    return createAlert(ctx, t.mint, target, dir);
  } catch (e) {
    return fail(ctx, e, ui.cb("Pick from a list", "al:new"));
  }
});

bot.command("delalert", async (ctx) => {
  const id = Number(words(ctx)[0]);
  if (!Number.isInteger(id)) return settings(ctx);
  store.deletePriceAlert(id, ctx.chat.id);
  return settings(ctx);
});

bot.command("link", async (ctx) => {
  if (isGroup(ctx)) return reply(ctx, ui.errorCard("Link your wallet in a private chat with me, so nobody else can change it."));
  const [q] = words(ctx);
  if (!q) return ask(ctx, { kind: "link" }, ui.prompts.link);
  try {
    const w = await resolveWallet(q);
    store.linkWallet(ctx.from!.id, ctx.from!.username, w.address, w.name);
    return reply(ctx, ui.linkedCard(store.walletOfUser(ctx.from!.id)!, Boolean(store.getWatch(ctx.chat.id, w.address))));
  } catch (e) {
    return fail(ctx, e, ui.cb("Try again", "lk:new"));
  }
});

bot.command("unlink", async (ctx) => {
  if (ctx.from) store.unlinkWallet(ctx.from.id);
  return settings(ctx);
});

bot.command("tip", async (ctx) => {
  const args = words(ctx);
  const replied = ctx.message?.reply_to_message;
  try {
    // Reply to someone's message: /tip 500
    if (replied?.from && args.length === 1 && parseAmount(args[0]) != null) {
      if (replied.from.is_bot) throw new Error("Bots can’t receive tips. Reply to a person’s message.");
      if (replied.from.id === ctx.from?.id) throw new Error("You can’t tip yourself.");
      const w = store.walletOfUser(replied.from.id);
      const who = replied.from.username ? `@${replied.from.username}` : replied.from.first_name;
      if (!w) {
        return reply(ctx, ui.tipNeedsLink(who, ctx.me.username));
      }
      return createTip(ctx, { address: w.address, label: who }, parseAmount(args[0])!);
    }
    // /tip name.cook 500  ·  /tip @user 500
    if (args.length >= 2 && parseAmount(args[1]) != null) {
      return createTip(ctx, await resolveRecipient(args[0]), parseAmount(args[1])!);
    }
    if (isGroup(ctx)) return reply(ctx, ui.tipUsage());
    return ask(ctx, { kind: "tipTo" }, ui.prompts.tipTo);
  } catch (e) {
    return fail(ctx, e);
  }
});

bot.command("send", async (ctx) => {
  const [q, amountStr] = words(ctx);
  const amount = parseAmount(amountStr ?? "");
  if (!q || amount == null) return reply(ctx, ui.errorCard("Use it like /send name.cook 250"));
  try {
    const to = await resolveRecipient(q);
    return reply(ctx, ui.sendCard(to.address, to.label, amount, await getCookPriceUsd().catch(() => null)));
  } catch (e) {
    return fail(ctx, e);
  }
});

// --- buttons -------------------------------------------------------------------------------------

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [ns, a, b, c, d] = data.split(":");
  const sourceText = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? (ctx.callbackQuery.message.text ?? "") : "";
  let toast: string | undefined;
  try {
    switch (ns) {
      case "m":
        await showHome(ctx, true);
        break;
      case "help":
        await replace(ctx, ui.help());
        break;
      case "mk":
        await replace(ctx, ui.marketCard(await topTokens(40), Number(a) || 0));
        toast = "Updated";
        break;
      case "st":
        await settings(ctx, true);
        break;
      case "pr":
        if (a === "r") {
          await replace(ctx, ui.priceCard(await priceOf(b === COOK_MINT ? "COOK" : b)));
          toast = "Price updated";
        } else {
          await reply(ctx, ui.priceCard(await priceOf(a === COOK_MINT ? "COOK" : a)));
        }
        break;
      case "pf":
        if (a === "ask") await ask(ctx, { kind: "portfolio" }, ui.prompts.portfolio);
        else if (a === "r") {
          const name = ctx.chat ? (store.getWatch(ctx.chat.id, b)?.label ?? null) : null;
          await portfolio(ctx, b, name, true);
          toast = "Balances updated";
        } else {
          const name = ctx.chat ? (store.getWatch(ctx.chat.id, a)?.label ?? null) : null;
          await portfolio(ctx, a, name);
        }
        break;
      case "w":
        if (a === "new") await ask(ctx, { kind: "watch" }, ui.prompts.watch);
        else if (a === "add") {
          await watch(ctx, b);
          toast = "Watching";
        } else if (a === "rn") await ask(ctx, { kind: "rename", address: b }, ui.prompts.rename);
        else if (a === "rm") {
          const w = ctx.chat ? store.getWatch(ctx.chat.id, b) : null;
          if (ctx.chat) store.removeWatch(ctx.chat.id, b);
          await syncWalletSubscriptions(ctx.api);
          toast = `Stopped watching ${w?.label ?? shortAddr(b)}`;
          if (sourceText.startsWith("⚙️")) await settings(ctx, true);
          else if (sourceText.startsWith("👀")) await replace(ctx, ui.stoppedCard(w?.label ?? shortAddr(b), b));
        }
        break;
      case "al":
        if (a === "new") await replace(ctx, ui.alertPicker(await topTokens(6)));
        else if (a === "other") await ask(ctx, { kind: "alertToken" }, ui.prompts.alertToken);
        else if (a === "t") await replace(ctx, ui.alertPresets(await priceOf(b === COOK_MINT ? "COOK" : b)));
        else if (a === "T") await reply(ctx, ui.alertPresets(await priceOf(b === COOK_MINT ? "COOK" : b)));
        else if (a === "p") {
          const t = await priceOf(b === COOK_MINT ? "COOK" : b);
          if (t.priceUsd == null) throw new Error(`${t.symbol} has no price right now, so a relative alert can’t be set.`);
          const pct = Number(d) / 100;
          const dir = c === "u" ? "above" : "below";
          await createAlert(ctx, t.mint, t.priceUsd * (dir === "above" ? 1 + pct : 1 - pct), dir, true);
          toast = "Alert set";
        } else if (a === "c") {
          const t = await priceOf(b === COOK_MINT ? "COOK" : b);
          await ask(ctx, { kind: "alertPrice", mint: t.mint }, ui.prompts.alertPrice(t.symbol, t.priceUsd));
        } else if (a === "rm") {
          if (ctx.chat) store.deletePriceAlert(Number(b), ctx.chat.id);
          toast = "Alert deleted";
          if (sourceText.startsWith("⚙️")) await settings(ctx, true);
          else await replace(ctx, ui.noticeCard("Alert deleted."));
        }
        break;
      case "lk":
        if (a === "new") {
          if (isGroup(ctx)) toast = "Link your wallet in a private chat with me";
          else await ask(ctx, { kind: "link" }, ui.prompts.link);
        } else if (a === "rm" && ctx.from) {
          store.unlinkWallet(ctx.from.id);
          toast = "Wallet unlinked";
          await settings(ctx, true);
        }
        break;
      case "tip":
        if (a === "new") await ask(ctx, { kind: "tipTo" }, ui.prompts.tipTo);
        else if (a === "a") {
          const entry = pending.get(pendingKey(ctx));
          if (entry?.p.kind !== "tipAmount") {
            toast = "This tip draft expired. Start again with /tip.";
            break;
          }
          if (b === "custom") {
            await ask(ctx, entry.p, ui.prompts.tipAmount);
          } else {
            pending.delete(pendingKey(ctx));
            await createTip(ctx, { address: entry.p.toAddress, label: entry.p.toLabel }, Number(b), true);
          }
        } else if (a === "x") {
          const tip = store.getTip(b);
          if (!tip) break;
          if (tip.creator_id != null && tip.creator_id !== ctx.from?.id) {
            toast = `Only ${tip.from_name} can cancel this tip`;
          } else if (store.markTip(tip.id, "cancelled")) {
            await refreshTipMessage(ctx.api, tip.id);
            toast = "Tip cancelled";
          }
        }
        break;
      case "q": {
        // Quick actions offered for a pasted address or .cook name.
        const w = await resolveWallet(b);
        if (a === "w") await watch(ctx, w.address);
        else if (a === "p") await portfolio(ctx, w.address, w.name);
        else if (a === "l" && ctx.from) {
          store.linkWallet(ctx.from.id, ctx.from.username, w.address, w.name);
          await replace(ctx, ui.linkedCard(store.walletOfUser(ctx.from.id)!, Boolean(ctx.chat && store.getWatch(ctx.chat.id, w.address))));
        } else if (a === "t") {
          const label = w.name ?? shortAddr(w.address);
          await replace(ctx, ui.tipAmountPicker(label));
          setPending(ctx, { kind: "tipAmount", toAddress: w.address, toLabel: label }, ctx.callbackQuery.message!.message_id);
        }
        break;
      }
    }
  } catch (e) {
    toast = (e as Error).message.slice(0, 190);
  }
  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => {});
});

// --- replies to prompts and free text ------------------------------------------------------------

async function handleInput(ctx: Context, p: Pending, text: string) {
  try {
    switch (p.kind) {
      case "watch":
        return await watch(ctx, text);
      case "portfolio": {
        const w = await resolveWallet(text);
        return await portfolio(ctx, w.address, w.name);
      }
      case "link": {
        const w = await resolveWallet(text);
        store.linkWallet(ctx.from!.id, ctx.from!.username, w.address, w.name);
        return await reply(ctx, ui.linkedCard(store.walletOfUser(ctx.from!.id)!, Boolean(store.getWatch(ctx.chat!.id, w.address))));
      }
      case "rename": {
        store.renameWatch(ctx.chat!.id, p.address, text.slice(0, 24));
        const w = store.getWatch(ctx.chat!.id, p.address);
        return await reply(ctx, w ? ui.watchingCard(w, "renamed") : ui.errorCard("That wallet isn’t watched here anymore."));
      }
      case "alertToken":
        return await reply(ctx, ui.alertPresets(await priceOf(text)));
      case "alertPrice": {
        const target = parsePrice(text);
        if (target == null) throw new Error("That doesn’t look like a price. Send a number like 0.0001.");
        return await createAlert(ctx, p.mint, target);
      }
      case "tipTo": {
        const to = await resolveRecipient(text);
        const msg = await reply(ctx, ui.tipAmountPicker(to.label));
        return setPending(ctx, { kind: "tipAmount", toAddress: to.address, toLabel: to.label }, msg.message_id);
      }
      case "tipAmount": {
        const amount = parseAmount(text);
        if (amount == null) throw new Error("Send a number of COOK, like 500 or 1.5k.");
        return await createTip(ctx, { address: p.toAddress, label: p.toLabel }, amount);
      }
    }
  } catch (e) {
    const retry: Record<Pending["kind"], ReturnType<typeof ui.cb>> = {
      watch: ui.cb("Try again", "w:new"),
      portfolio: ui.cb("Try again", "pf:ask"),
      link: ui.cb("Try again", "lk:new"),
      rename: ui.cb("‹ Settings", "st"),
      alertToken: ui.cb("Pick from a list", "al:new"),
      alertPrice: ui.cb("Pick from a list", "al:new"),
      tipTo: ui.cb("Try again", "tip:new"),
      tipAmount: ui.cb("Start over", "tip:new"),
    };
    return fail(ctx, e, retry[p.kind]);
  }
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  const key = pendingKey(ctx);
  const entry = pending.get(key);
  if (entry && Date.now() - entry.at > PENDING_TTL_MS) pending.delete(key);
  const repliedToPrompt = entry && ctx.message.reply_to_message?.message_id === entry.promptId;
  if (entry && (ctx.chat.type === "private" || repliedToPrompt)) {
    pending.delete(key);
    return handleInput(ctx, entry.p, text);
  }
  if (ctx.chat.type !== "private") return;

  // No question pending: guess what a pasted value is.
  const token = text.split(/\s+/)[0];
  if (looksLikeName(token) && (token.toLowerCase().endsWith(".cook") || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token))) {
    try {
      const w = await resolveWallet(token);
      return reply(ctx, ui.quickActions(w.address, w.name));
    } catch (e) {
      return fail(ctx, e);
    }
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) {
    const t = await findToken(token);
    if (t) return reply(ctx, ui.priceCard(t));
    return reply(ctx, ui.quickActions(token, null));
  }
  const t = await findToken(token).catch(() => null);
  if (t) return reply(ctx, ui.priceCard(t));
  return showHome(ctx);
});

// --- inline mode: @bot bCOOK in any chat ---------------------------------------------------------

const urlOnly = (m?: InlineKeyboardMarkup): InlineKeyboardMarkup | undefined => {
  const rows = (m?.inline_keyboard ?? []).map((r) => r.filter((btn) => "url" in btn)).filter((r) => r.length);
  return rows.length ? { inline_keyboard: rows } : undefined;
};

bot.on("inline_query", async (ctx) => {
  const q = ctx.inlineQuery.query.trim();
  const results: InlineQueryResultArticle[] = [];
  const article = (id: string, title: string, description: string, c: ui.Card): InlineQueryResultArticle => ({
    type: "article",
    id: id.slice(0, 64),
    title,
    description,
    input_message_content: { message_text: c.text, ...HTML },
    ...(urlOnly(c.reply_markup) ? { reply_markup: urlOnly(c.reply_markup) } : {}),
  });
  try {
    if (!q) {
      const cook = await findToken("COOK");
      const list = [...(cook ? [cook] : []), ...(await topTokens(6))];
      for (const t of list) results.push(article(`p:${t.mint}`, `${t.symbol} · ${fmtPrice(t.priceUsd)}`, `${fmtAmount(t.holders)} holders`, ui.priceCard(t)));
    } else if (q.toLowerCase().endsWith(".cook") || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
      const w = await resolveWallet(q);
      const p = await getPortfolio(w.address);
      results.push(article(`w:${w.address}`, `💼 ${w.name ?? shortAddr(w.address)}`, `${fmtAmount(p.cook)} COOK · ${p.tokens.length} tokens`, ui.portfolioCard(w.address, w.name, p, false)));
    } else {
      const t = await findToken(q);
      if (t) results.push(article(`p:${t.mint}`, `${t.symbol} · ${fmtPrice(t.priceUsd)}`, t.name || "Price card", ui.priceCard(t)));
    }
  } catch {
    /* empty result set is a fine answer */
  }
  await ctx.answerInlineQuery(results, { cache_time: 20, is_personal: false });
});

bot.catch((err) => console.error("[bot]", err.error));

await startWatchers(bot.api);
console.log("[bot] CookieBot is running");
await bot.start({ drop_pending_updates: true, allowed_updates: ["message", "callback_query", "inline_query"] });
