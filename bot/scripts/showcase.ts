// Sends a clean set of real, live cards to one chat for screenshots: `npm run showcase -- <chatId> <wallet>`.
// Buttons stay functional because the deployed bot handles their callbacks.
import { Bot } from "grammy";

import { findToken, getPortfolio, resolveWallet, topTokens } from "../src/chain.js";
import { botToken } from "../src/config.js";
import * as ui from "../src/ui.js";

const [chatArg, walletArg] = process.argv.slice(2);
const chatId = Number(chatArg);
if (!Number.isInteger(chatId) || !walletArg) {
  console.error("usage: npm run showcase -- <chatId> <address|name.cook>");
  process.exit(1);
}

const api = new Bot(botToken()).api;
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const pause = () => new Promise((r) => setTimeout(r, 1200));

async function send(label: string, c: ui.Card) {
  await api.sendMessage(chatId, c.text, { ...HTML, ...(c.reply_markup ? { reply_markup: c.reply_markup } : {}) });
  console.log(`✔ ${label}`);
  await pause();
}

const w = await resolveWallet(walletArg);
const balance = await getPortfolio(w.address);
const bcook = await findToken("bCOOK");
const tokens = await topTokens(40);
const wallet = { user_id: chatId, username: null, address: w.address, name: w.name };

await send("menu", ui.home(wallet, balance.cook, false));
if (bcook) await send("price card", ui.priceCard(bcook));
await send("market", ui.marketCard(tokens, 0));
await send("portfolio", ui.portfolioCard(w.address, w.name, balance, true));
if (bcook) await send("alert presets", ui.alertPresets(bcook));
await send("alert picker", ui.alertPicker(tokens));
process.exit(0);
