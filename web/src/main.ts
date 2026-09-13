import "./style.css";

import { Buffer } from "buffer";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import {
  COOK_DECIMALS, COOK_MINT, MEMO_PROGRAM, buildSwap, connection, cookBalance, cookPriceUsd, explorerToken,
  explorerTx, fromRaw, loadMarketTokens, mintDecimals, quoteSwap, recentActivity, resolveRecipient, toRaw,
  tokenBalance, type MarketToken,
} from "./api";
import { connectNightly, onAccountChange, signSendConfirm } from "./wallet";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  netBadge: $("netBadge"), connectBtn: $<HTMLButtonElement>("connectBtn"),
  walletLine: $("walletLine"), balances: $("balances"), tgLink: $<HTMLAnchorElement>("tgLink"),
  sendTitle: $("sendTitle"), sendForm: $<HTMLFormElement>("sendForm"), sendTo: $<HTMLInputElement>("sendTo"),
  sendResolved: $("sendResolved"), sendAmount: $<HTMLInputElement>("sendAmount"), sendMemo: $<HTMLInputElement>("sendMemo"),
  sendBtn: $<HTMLButtonElement>("sendBtn"),
  swapForm: $<HTMLFormElement>("swapForm"), swapAmount: $<HTMLInputElement>("swapAmount"),
  swapToken: $<HTMLSelectElement>("swapToken"), swapQuote: $("swapQuote"), swapBtn: $<HTMLButtonElement>("swapBtn"),
  status: $("status"), activity: $("activity"), market: $<HTMLTableElement>("market"),
};

const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME as string | undefined;
let owner: PublicKey | null = null;
let tokens: MarketToken[] = [];
let cookUsd: number | null = null;
let busy = false;

// --- formatting ----------------------------------------------------------------------------------

function fmtAmount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 1 || a === 0) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}
const fmtPrice = (n: number | null) => (n == null ? "—" : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(4)}`);
const fmtUsd = (n: number | null) =>
  n == null ? "—" : n === 0 ? "$0" : n >= 0.01 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "<$0.01";
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, attrs: Record<string, string> = {}) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function setStatus(text: string, kind: "" | "ok" | "err" = "", sig?: string) {
  el.status.className = `status ${kind}`;
  el.status.replaceChildren(document.createTextNode(text));
  if (sig) {
    el.status.append(" ", node("a", "View on Cookiescan ↗", { href: explorerTx(sig), target: "_blank", rel: "noopener" }));
  }
}

function pushActivity(text: string, sig: string, ok = true) {
  el.activity.querySelector(".muted")?.remove();
  const li = node("li");
  li.append(node("span", `${ok ? "✅" : "⚠️"} ${text}`), node("a", short(sig), { href: explorerTx(sig), target: "_blank", rel: "noopener" }));
  el.activity.prepend(li);
}

const stageText = { signing: "Approve in Nightly…", sending: "Broadcasting to Cookie Chain…", confirming: "Waiting for confirmation…" };

// --- network + market ----------------------------------------------------------------------------

async function checkNetwork() {
  try {
    const slot = await connection.getSlot();
    el.netBadge.textContent = `Cookie Chain · slot ${slot.toLocaleString("en-US")}`;
    el.netBadge.classList.add("live");
  } catch {
    el.netBadge.textContent = "RPC unreachable";
    el.netBadge.classList.remove("live");
  }
}

function renderMarket() {
  const head = el.market.tHead!.rows[0];
  head.replaceChildren(...["Token", "Price", "Liquidity", "Pools", ""].map((h) => node("th", h)));
  const body = el.market.tBodies[0];
  body.replaceChildren(
    ...tokens.slice(0, 15).map((t) => {
      const tr = node("tr");
      const name = node("td");
      name.append(node("a", t.symbol, { href: explorerToken(t.mint), target: "_blank", rel: "noopener" }));
      const action = node("td");
      const btn = node("button", "Swap", { type: "button" });
      btn.addEventListener("click", () => {
        el.swapToken.value = t.mint;
        void refreshQuote();
        el.swapForm.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      action.append(btn);
      tr.append(name, node("td", fmtPrice(t.priceUsd)), node("td", fmtUsd(t.liquidityUsd)), node("td", String(t.pools)), action);
      return tr;
    }),
  );
  el.swapToken.replaceChildren(
    node("option", "Choose token…", { value: "" }),
    ...tokens.map((t) => node("option", `${t.symbol} · ${fmtPrice(t.priceUsd)}`, { value: t.mint })),
  );
}

async function loadMarket() {
  [tokens, cookUsd] = await Promise.all([loadMarketTokens(), cookPriceUsd()]);
  renderMarket();
}

// --- wallet --------------------------------------------------------------------------------------

async function refreshWallet() {
  if (!owner) return;
  const cook = await cookBalance(owner);
  const lines = [node("div", `${fmtAmount(cook)} COOK`, { class: "big" }), node("div", `≈ ${fmtUsd(cookUsd != null ? cook * cookUsd : null)}`, { class: "muted" })];
  const mint = el.swapToken.value;
  if (mint) {
    const t = tokens.find((x) => x.mint === mint);
    lines.push(node("div", `${fmtAmount(await tokenBalance(owner, mint))} ${t?.symbol ?? "token"}`, { class: "muted" }));
  }
  el.balances.replaceChildren(...lines);
}

async function loadActivity() {
  if (!owner) return;
  const sigs = await recentActivity(owner);
  if (!sigs.length) return;
  el.activity.replaceChildren(
    ...sigs.map((s) => {
      const li = node("li");
      const when = s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : "pending";
      li.append(node("span", `${s.err ? "⚠️ failed" : "✅"} ${when}${s.memo ? ` · ${s.memo}` : ""}`), node("a", short(s.signature), { href: explorerTx(s.signature), target: "_blank", rel: "noopener" }));
      return li;
    }),
  );
}

async function connect() {
  try {
    el.connectBtn.disabled = true;
    setStatus("Connecting to Nightly…");
    owner = await connectNightly();
    const addr = owner.toBase58();
    el.connectBtn.textContent = short(addr);
    el.walletLine.replaceChildren(node("code", addr));
    el.sendBtn.disabled = false;
    el.swapBtn.disabled = !el.swapToken.value;
    if (BOT_USERNAME) {
      el.tgLink.href = `https://t.me/${BOT_USERNAME}?start=watch_${addr}`;
      el.tgLink.hidden = false;
    }
    setStatus("Connected to Cookie Chain.", "ok");
    onAccountChange(() => location.reload());
    await Promise.all([refreshWallet(), loadActivity()]);
  } catch (e) {
    setStatus((e as Error).message, "err");
  } finally {
    el.connectBtn.disabled = false;
  }
}

// --- send ----------------------------------------------------------------------------------------

async function previewRecipient() {
  const v = el.sendTo.value.trim();
  if (!v) return (el.sendResolved.textContent = "");
  try {
    const r = await resolveRecipient(v);
    el.sendResolved.className = "hint ok";
    el.sendResolved.textContent = r.name ? `${r.name} → ${r.address}` : "Valid address";
  } catch (e) {
    el.sendResolved.className = "hint err";
    el.sendResolved.textContent = (e as Error).message;
  }
}

async function send(ev: SubmitEvent) {
  ev.preventDefault();
  if (!owner || busy) return;
  const amount = Number(el.sendAmount.value);
  if (!(amount > 0)) return setStatus("Enter an amount above 0.", "err");
  busy = true;
  el.sendBtn.disabled = true;
  try {
    const to = await resolveRecipient(el.sendTo.value);
    const lamports = toRaw(amount, COOK_DECIMALS);
    const balance = BigInt(await connection.getBalance(owner));
    if (lamports + 10_000n > balance) throw new Error(`Not enough COOK: you have ${fmtAmount(Number(balance) / 1e9)}.`);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(to.address), lamports }));
    const memo = el.sendMemo.value.trim();
    if (memo) {
      tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from(memo, "utf8") }));
    }
    const sig = await signSendConfirm(connection, tx, blockhash, lastValidBlockHeight, (s) => setStatus(stageText[s]));
    const label = to.name ?? short(to.address);
    setStatus(`Sent ${fmtAmount(amount)} COOK to ${label}.${memo.startsWith("cookiebot:tip:") ? " The Telegram chat will confirm it in a few seconds." : ""}`, "ok", sig);
    pushActivity(`Sent ${fmtAmount(amount)} COOK → ${label}`, sig);
    await refreshWallet();
  } catch (e) {
    setStatus((e as Error).message, "err");
  } finally {
    busy = false;
    el.sendBtn.disabled = !owner;
  }
}

// --- swap ----------------------------------------------------------------------------------------

let quoteTimer: number | undefined;
let quoteSeq = 0;

async function refreshQuote() {
  const mint = el.swapToken.value;
  const amount = Number(el.swapAmount.value);
  el.swapBtn.disabled = !owner || !mint || !(amount > 0);
  if (!mint || !(amount > 0)) return (el.swapQuote.textContent = "Pick a token and an amount.");
  const seq = ++quoteSeq;
  el.swapQuote.className = "hint";
  el.swapQuote.textContent = "Quoting…";
  try {
    const [route, decimals] = await Promise.all([quoteSwap(mint, toRaw(amount, COOK_DECIMALS)), mintDecimals(mint)]);
    if (seq !== quoteSeq) return;
    const t = tokens.find((x) => x.mint === mint);
    if (!route) {
      el.swapQuote.className = "hint err";
      el.swapQuote.textContent = "No route for this pair right now.";
      el.swapBtn.disabled = true;
      return;
    }
    const venues = [...new Set(route.segments.map((s) => s.venue))].join(" + ");
    const impact = route.priceImpactPct == null ? "—" : `${route.priceImpactPct.toFixed(2)}%`;
    el.swapQuote.textContent =
      `≈ ${fmtAmount(fromRaw(route.netOutAmount, decimals))} ${t?.symbol ?? ""} · min ${fmtAmount(fromRaw(route.minOutAmount, decimals))} · ` +
      `fee ${route.feePct}% · impact ${impact} · via ${venues}`;
    if (owner) void refreshWallet();
  } catch (e) {
    if (seq !== quoteSeq) return;
    el.swapQuote.className = "hint err";
    el.swapQuote.textContent = (e as Error).message;
  }
}

function scheduleQuote() {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(() => void refreshQuote(), 400);
}

async function swap(ev: SubmitEvent) {
  ev.preventDefault();
  const mint = el.swapToken.value;
  const amount = Number(el.swapAmount.value);
  if (!owner || busy || !mint || !(amount > 0)) return;
  busy = true;
  el.swapBtn.disabled = true;
  try {
    setStatus("Building swap with the Cookiebox aggregator…");
    const [built, decimals] = await Promise.all([buildSwap(mint, toRaw(amount, COOK_DECIMALS), owner), mintDecimals(mint)]);
    const sig = await signSendConfirm(connection, built.tx, built.blockhash, built.lastValidBlockHeight, (s) => setStatus(stageText[s]));
    const symbol = tokens.find((x) => x.mint === mint)?.symbol ?? "token";
    const got = fmtAmount(fromRaw(built.route.netOutAmount, decimals));
    setStatus(`Swapped ${fmtAmount(amount)} COOK → ~${got} ${symbol}.`, "ok", sig);
    pushActivity(`Swap ${fmtAmount(amount)} COOK → ~${got} ${symbol}`, sig);
    await refreshWallet();
  } catch (e) {
    setStatus((e as Error).message, "err");
  } finally {
    busy = false;
    void refreshQuote();
  }
}

// --- boot ----------------------------------------------------------------------------------------

function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  const to = p.get("to");
  if (to) {
    el.sendTo.value = to;
    el.sendAmount.value = p.get("amount") ?? "";
    el.sendMemo.value = p.get("memo") ?? "";
    const label = p.get("label");
    if (el.sendMemo.value.startsWith("cookiebot:tip:")) {
      el.sendTitle.textContent = `Tip ${label ?? ""} in COOK`;
      el.sendMemo.readOnly = true;
    }
    void previewRecipient();
    document.getElementById("sendCard")?.scrollIntoView({ block: "center" });
  }
  const swapMint = p.get("swap");
  if (swapMint && tokens.some((t) => t.mint === swapMint)) {
    el.swapToken.value = swapMint;
    void refreshQuote();
    document.getElementById("swapCard")?.scrollIntoView({ block: "center" });
  }
}

el.connectBtn.addEventListener("click", () => void connect());
el.sendForm.addEventListener("submit", (e) => void send(e));
el.sendTo.addEventListener("change", () => void previewRecipient());
el.swapForm.addEventListener("submit", (e) => void swap(e));
el.swapToken.addEventListener("change", () => void refreshQuote());
el.swapAmount.addEventListener("input", scheduleQuote);

void checkNetwork();
setInterval(() => void checkNetwork(), 15_000);
loadMarket()
  .catch((e) => setStatus(`Market data unavailable: ${(e as Error).message}`, "err"))
  .finally(applyUrlParams);

// COOK_MINT is re-exported for console debugging of routes.
Object.assign(window, { cookiebot: { COOK_MINT, connection } });
