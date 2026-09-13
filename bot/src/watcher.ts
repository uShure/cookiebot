// Background jobs: live wallet alerts (WebSocket logsSubscribe), price alerts, tip payment detection.
import { PublicKey } from "@solana/web3.js";
import type { Api } from "grammy";

import { connection, describeWalletTx, findToken, getCookPriceUsd, getRegistry, COOK_MINT, type WalletTxEffect } from "./chain.js";
import { config } from "./config.js";
import { fmtAmount, fmtUsd } from "./format.js";
import * as store from "./store.js";
import { activityCard, alertFired, tipCard, TIP_TTL_MINUTES, type ActivityLine, type Card } from "./ui.js";

export const tipMemo = (id: string) => `cookiebot:tip:${id}`;

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export async function sendCard(api: Api, chatId: number, c: Card) {
  return api.sendMessage(chatId, c.text, { ...HTML, ...(c.reply_markup ? { reply_markup: c.reply_markup } : {}) });
}

export async function editCard(api: Api, chatId: number, messageId: number, c: Card) {
  return api.editMessageText(chatId, messageId, c.text, { ...HTML, reply_markup: c.reply_markup ?? { inline_keyboard: [] } });
}

const logSendError = (where: string) => (e: { description?: string; message?: string }) =>
  console.error(`[${where}]`, e.description ?? e.message);

// --- Wallet alerts -------------------------------------------------------------------------------

const subscriptions = new Map<string, number>();
const seen = new Map<string, number>();

function alreadySeen(key: string): boolean {
  if (seen.has(key)) return true;
  seen.set(key, Date.now());
  if (seen.size > 5000) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
  }
  return false;
}

async function describeLines(effect: WalletTxEffect): Promise<ActivityLine[]> {
  const [cookPrice, registry] = await Promise.all([getCookPriceUsd(), getRegistry()]);
  return effect.changes.map((c) => {
    const price = c.mint === COOK_MINT ? cookPrice : registry.get(c.mint)?.priceUsd;
    const usd = price != null ? Math.abs(c.delta) * price : null;
    return { text: `${c.delta > 0 ? "+" : "−"}${fmtAmount(Math.abs(c.delta))} ${c.symbol}`, usd: usd != null ? fmtUsd(usd) : null };
  });
}

function kindOf(effect: WalletTxEffect) {
  if (effect.failed) return "failed" as const;
  const up = effect.changes.some((c) => c.delta > 0);
  const down = effect.changes.some((c) => c.delta < 0);
  if (up && down) return "swap" as const;
  if (up) return "received" as const;
  if (down) return "sent" as const;
  return "activity" as const;
}

async function onWalletLogs(api: Api, address: string, signature: string): Promise<void> {
  if (alreadySeen(`${address}:${signature}`)) return;
  // The RPC may not serve the transaction the instant its log arrives.
  let effect: WalletTxEffect | null = null;
  for (let attempt = 0; attempt < 5 && !effect; attempt++) {
    effect = await describeWalletTx(signature, address).catch(() => null);
    if (!effect) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!effect || (effect.changes.length === 0 && !effect.failed)) return;
  const lines = await describeLines(effect);
  for (const w of store.watchersOf(address)) {
    const c = activityCard({
      kind: kindOf(effect),
      address,
      label: w.label,
      lines,
      counterparty: effect.counterparty,
      memo: effect.memo?.startsWith("cookiebot:tip:") ? null : effect.memo,
      signature,
    });
    await sendCard(api, w.chat_id, c).catch(logSendError("watch"));
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
    if (!hit || !store.deletePriceAlert(a.id)) continue;
    await sendCard(api, a.chat_id, alertFired(a, price)).catch(logSendError("price"));
  }
}

// --- Tips ----------------------------------------------------------------------------------------

/** Re-render a tip message in place after its status changed. */
export async function refreshTipMessage(api: Api, tipId: string): Promise<void> {
  const tip = store.getTip(tipId);
  if (!tip?.message_id) return;
  const c = tipCard(tip, await getCookPriceUsd().catch(() => null));
  await editCard(api, tip.chat_id, tip.message_id, c).catch(logSendError("tips"));
}

async function checkTips(api: Api): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const byRecipient = new Map<string, store.Tip[]>();
  for (const t of store.pendingTips()) {
    if (nowSec - t.created_at > TIP_TTL_MINUTES * 60) {
      if (store.markTip(t.id, "expired")) await refreshTipMessage(api, t.id);
      continue;
    }
    byRecipient.set(t.to_address, [...(byRecipient.get(t.to_address) ?? []), t]);
  }
  for (const [recipient, list] of byRecipient) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(recipient), { limit: 25 }).catch(() => []);
    for (const tip of list) {
      const match = sigs.find((s) => !s.err && s.memo?.includes(tipMemo(tip.id)));
      if (match && store.markTip(tip.id, "paid", match.signature)) await refreshTipMessage(api, tip.id);
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
