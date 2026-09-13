// Background jobs: live wallet alerts (WebSocket logsSubscribe), price alerts, tip payment detection.
import { PublicKey } from "@solana/web3.js";
import type { Api } from "grammy";

import { connection, describeWalletTx, findToken, getCookPriceUsd, getRegistry, COOK_MINT, type WalletTxEffect } from "./chain.js";
import { config } from "./config.js";
import { escapeHtml, explorerTx, fmtAmount, fmtPrice, fmtUsd, shortAddr } from "./format.js";
import * as store from "./store.js";

const TIP_TTL_SECONDS = 60 * 60;
export const tipMemo = (id: string) => `cookiebot:tip:${id}`;

// --- Wallet alerts -------------------------------------------------------------------------------

const subscriptions = new Map<string, number>();
const seen = new Map<string, number>(); // `${address}:${sig}` → time, to drop duplicate notifications

function alreadySeen(key: string): boolean {
  if (seen.has(key)) return true;
  seen.set(key, Date.now());
  if (seen.size > 5000) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
  }
  return false;
}

async function usdValue(mint: string, amount: number): Promise<number | null> {
  const price = mint === COOK_MINT ? await getCookPriceUsd() : (await getRegistry()).get(mint)?.priceUsd;
  return price != null ? Math.abs(amount) * price : null;
}

async function renderEffect(effect: WalletTxEffect, address: string, label: string | null): Promise<string> {
  const who = label ? `<b>${escapeHtml(label)}</b> <code>${shortAddr(address)}</code>` : `<code>${shortAddr(address)}</code>`;
  const incoming = effect.changes.some((c) => c.delta > 0) && !effect.changes.some((c) => c.delta < 0);
  const head = effect.failed ? "⚠️ Failed transaction" : incoming ? "📥 Incoming" : "🔄 Activity";
  const lines = [`${head} · ${who}`];
  for (const c of effect.changes) {
    const usd = await usdValue(c.mint, c.delta);
    const sign = c.delta > 0 ? "+" : "−";
    lines.push(`${sign}${fmtAmount(Math.abs(c.delta))} ${escapeHtml(c.symbol)}${usd != null ? ` (${fmtUsd(usd)})` : ""}`);
  }
  if (effect.memo) lines.push(`📝 ${escapeHtml(effect.memo.slice(0, 200))}`);
  lines.push(`<a href="${explorerTx(effect.signature)}">View on Cookiescan</a>`);
  return lines.join("\n");
}

async function onWalletLogs(api: Api, address: string, signature: string): Promise<void> {
  if (alreadySeen(`${address}:${signature}`)) return;
  // The RPC may not serve the tx the instant the log arrives.
  let effect: WalletTxEffect | null = null;
  for (let attempt = 0; attempt < 5 && !effect; attempt++) {
    effect = await describeWalletTx(signature, address).catch(() => null);
    if (!effect) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!effect || effect.changes.length === 0) return;
  for (const w of store.watchersOf(address)) {
    const text = await renderEffect(effect, address, w.label);
    await api.sendMessage(w.chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch((e) => {
      console.error(`[watch] send to ${w.chat_id} failed:`, e.description ?? e.message);
    });
  }
}

/** Reconcile live subscriptions with the watches table. Call after any add/remove. */
export async function syncWalletSubscriptions(api: Api): Promise<void> {
  const wanted = new Set(store.watchedAddresses());
  for (const [address, id] of subscriptions) {
    if (wanted.has(address)) continue;
    subscriptions.delete(address);
    await connection.removeOnLogsListener(id).catch(() => {});
  }
  for (const address of wanted) {
    if (subscriptions.has(address)) continue;
    const id = connection.onLogs(
      new PublicKey(address),
      (logs) => void onWalletLogs(api, address, logs.signature).catch((e) => console.error("[watch]", e)),
      "confirmed",
    );
    subscriptions.set(address, id);
  }
  console.log(`[watch] live subscriptions: ${subscriptions.size}`);
}

// --- Price alerts --------------------------------------------------------------------------------

async function checkPriceAlerts(api: Api): Promise<void> {
  const alerts = store.allPriceAlerts();
  if (!alerts.length) return;
  const prices = new Map<string, number | null>();
  for (const a of alerts) {
    if (!prices.has(a.mint)) prices.set(a.mint, (await findToken(a.mint === COOK_MINT ? "COOK" : a.mint))?.priceUsd ?? null);
    const price = prices.get(a.mint);
    if (price == null) continue;
    const hit = a.direction === "above" ? price >= a.target : price <= a.target;
    if (!hit) continue;
    store.deletePriceAlert(a.id);
    const arrow = a.direction === "above" ? "🚀" : "📉";
    await api
      .sendMessage(
        a.chat_id,
        `${arrow} <b>${escapeHtml(a.symbol)}</b> is ${a.direction} ${fmtPrice(a.target)}\nNow: <b>${fmtPrice(price)}</b>`,
        { parse_mode: "HTML" },
      )
      .catch((e) => console.error("[price] send failed:", e.description ?? e.message));
  }
}

// --- Tips ----------------------------------------------------------------------------------------

async function checkTips(api: Api): Promise<void> {
  const tips = store.pendingTips();
  const nowSec = Math.floor(Date.now() / 1000);
  const byRecipient = new Map<string, store.Tip[]>();
  for (const t of tips) {
    if (nowSec - t.created_at > TIP_TTL_SECONDS) {
      store.markTip(t.id, "expired");
      continue;
    }
    byRecipient.set(t.to_address, [...(byRecipient.get(t.to_address) ?? []), t]);
  }
  for (const [recipient, list] of byRecipient) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(recipient), { limit: 25 }).catch(() => []);
    for (const tip of list) {
      const match = sigs.find((s) => !s.err && s.memo?.includes(tipMemo(tip.id)));
      if (!match) continue;
      store.markTip(tip.id, "paid", match.signature);
      const text =
        `✅ <b>${escapeHtml(tip.from_name)}</b> tipped <b>${fmtAmount(tip.amount)} COOK</b> to ${escapeHtml(tip.to_label)}\n` +
        `<a href="${explorerTx(match.signature)}">Confirmed on Cookie Chain</a>`;
      const opts = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
      if (tip.message_id) {
        await api.editMessageText(tip.chat_id, tip.message_id, text, opts).catch(() => api.sendMessage(tip.chat_id, text, opts));
      } else {
        await api.sendMessage(tip.chat_id, text, opts).catch(() => {});
      }
    }
  }
}

function every(ms: number, name: string, job: () => Promise<void>): void {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((e) => console.error(`[${name}]`, e))
      .finally(() => {
        running = false;
      });
  }, ms);
}

export async function startWatchers(api: Api): Promise<void> {
  await syncWalletSubscriptions(api);
  every(config.priceCheckSeconds * 1000, "price", () => checkPriceAlerts(api));
  every(8_000, "tips", () => checkTips(api));
}
