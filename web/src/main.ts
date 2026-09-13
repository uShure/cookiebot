import "./fonts";
import "./style.css";

import { Buffer } from "buffer";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import {
  COOK_DECIMALS, MEMO_PROGRAM, buildSwap, connection, cookBalance, cookPriceUsd, explorerToken, explorerTx,
  fromRaw, loadMarketTokens, mintDecimals, quoteSwap, recentActivity, resolveRecipient, toRaw, tokenBalance,
  type AggRoute, type MarketToken,
} from "./api";
import { startChatDemo } from "./demo";
import { fmtAmount, fmtPrice, fmtUsd, h, short, timeAgo } from "./format";
import { connectNightly, onAccountChange, signSendConfirm } from "./wallet";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  connectBtn: $<HTMLButtonElement>("connectBtn"), connectLabel: $("connectLabel"),
  netBadge: $("netBadge"), liveDot: $("liveDot"), botCta: $<HTMLAnchorElement>("botCta"),
  statSlot: $("statSlot"), statPrice: $("statPrice"), statPairs: $("statPairs"),
  tickerTrack: $("tickerTrack"), chatDemo: $("chatDemo"), demoStatus: $("demoStatus"),
  tabs: document.querySelector<HTMLElement>(".tabs")!, tabSend: $<HTMLButtonElement>("tabSend"), tabSwap: $<HTMLButtonElement>("tabSwap"),
  sendForm: $<HTMLFormElement>("sendForm"), tipNote: $("tipNote"), sendTo: $<HTMLInputElement>("sendTo"),
  sendResolved: $("sendResolved"), sendAmount: $<HTMLInputElement>("sendAmount"), sendMemo: $<HTMLInputElement>("sendMemo"),
  sendBtn: $<HTMLButtonElement>("sendBtn"),
  swapForm: $<HTMLFormElement>("swapForm"), swapAmount: $<HTMLInputElement>("swapAmount"),
  swapToken: $<HTMLSelectElement>("swapToken"), swapQuote: $("swapQuote"), swapBtn: $<HTMLButtonElement>("swapBtn"),
  ticket: $("ticket"), ticketNo: $("ticketNo"), ticketLines: $("ticketLines"), stages: $("stages"),
  status: $("status"), ticketLink: $<HTMLAnchorElement>("ticketLink"), stamp: $("stamp"),
  walletLine: $("walletLine"), balCook: $("balCook"), balUsd: $("balUsd"), tgLink: $<HTMLAnchorElement>("tgLink"),
  activity: $("activity"), shelfList: $("shelfList"), toast: $("toast"),
};

const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME as string | undefined) ?? "pechenietest_bot";
const NETWORK_FEE = 0.000005;

let owner: PublicKey | null = null;
let cookBal = 0;
let tokens: MarketToken[] = [];
let cookUsd: number | null = null;
let mode: "send" | "swap" = "send";
let busy = false;
let lastQuote: { route: AggRoute; decimals: number; mint: string } | null = null;

// --- small helpers -------------------------------------------------------------------------------

function tick(node: HTMLElement, text: string) {
  if (node.textContent === text) return;
  node.textContent = text;
  node.classList.remove("tick");
  void node.offsetWidth;
  node.classList.add("tick");
}

let toastTimer: number | undefined;
function toast(text: string) {
  ui.toast.textContent = text;
  ui.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("show"), 2200);
}

function debounce<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let t: number | undefined;
  return (...a: T) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

const tokenByMint = (mint: string) => tokens.find((t) => t.mint === mint);

// --- ticket --------------------------------------------------------------------------------------

type Stage = "build" | "signing" | "sending" | "confirming";
const STAGES: Stage[] = ["build", "signing", "sending", "confirming"];
const stageText: Record<Stage, string> = {
  build: "Building the transaction…",
  signing: "Approve it in Nightly…",
  sending: "Broadcasting to Cookie Chain…",
  confirming: "Waiting for confirmation…",
};

function newTicketNumber() {
  ui.ticketNo.textContent = `No. ${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
}

function setLines(rows: [string, string][], total?: [string, string]) {
  ui.ticketLines.replaceChildren(
    ...rows.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))),
    ...(total ? [h("div", { class: "total" }, h("dt", {}, total[0]), h("dd", {}, total[1]))] : []),
  );
}

function setStage(stage: Stage | "done" | "failed" | null) {
  const idx = stage && stage !== "done" && stage !== "failed" ? STAGES.indexOf(stage) : -1;
  ui.stages.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("done", stage === "done" || (idx > -1 && i < idx));
    li.classList.toggle("active", i === idx);
    li.classList.remove("failed");
  });
  if (stage === "failed") {
    const active = ui.stages.querySelector("li.active") ?? ui.stages.querySelector("li:not(.done)");
    active?.classList.add("failed");
  }
  if (stage && stage !== "done" && stage !== "failed") setStatus(stageText[stage]);
}

function setStatus(text: string, kind: "" | "ok" | "err" = "") {
  ui.status.textContent = text;
  ui.status.className = `ticket-status ${kind}`;
}

function resetTicket(print = false) {
  ui.stamp.className = "stamp";
  ui.ticketLink.hidden = true;
  setStage(null);
  setStatus("");
  if (print) {
    newTicketNumber();
    ui.ticket.classList.remove("printing");
    void ui.ticket.offsetWidth;
    ui.ticket.classList.add("printing");
  }
}

function stamp(ok: boolean, sig?: string) {
  ui.stamp.textContent = ok ? "Baked" : "Burnt";
  ui.stamp.className = `stamp show${ok ? "" : " burnt"}`;
  if (sig) {
    ui.ticketLink.href = explorerTx(sig);
    ui.ticketLink.hidden = false;
  }
}

function previewSend() {
  const amount = Number(ui.sendAmount.value) || 0;
  const to = ui.sendTo.value.trim();
  const resolved = ui.sendResolved.dataset.name;
  const rows: [string, string][] = [
    ["To", resolved || (to ? short(to) : "—")],
    ["Amount", amount ? `${fmtAmount(amount)} COOK` : "—"],
  ];
  if (ui.sendMemo.value.trim()) rows.push(["Memo", ui.sendMemo.value.trim().slice(0, 40)]);
  rows.push(["Network fee", `${NETWORK_FEE} COOK`]);
  const usd = cookUsd != null && amount ? ` · ${fmtUsd(amount * cookUsd)}` : "";
  setLines(rows, ["Total", amount ? `${fmtAmount(amount + NETWORK_FEE)} COOK${usd}` : "—"]);
}

function previewSwap() {
  const amount = Number(ui.swapAmount.value) || 0;
  const t = tokenByMint(ui.swapToken.value);
  const rows: [string, string][] = [
    ["Pay", amount ? `${fmtAmount(amount)} COOK` : "—"],
    ["Receive", t ? t.symbol : "—"],
  ];
  if (lastQuote && t && lastQuote.mint === t.mint) {
    const { route, decimals } = lastQuote;
    rows[1] = ["Receive ≈", `${fmtAmount(fromRaw(route.netOutAmount, decimals))} ${t.symbol}`];
    rows.push(["Minimum", `${fmtAmount(fromRaw(route.minOutAmount, decimals))} ${t.symbol}`]);
    rows.push(["Route", [...new Set(route.segments.map((s) => s.venue))].join(" + ")]);
    rows.push(["Aggregator fee", `${route.feePct}%`]);
  }
  setLines(rows, ["Price impact", lastQuote && t && lastQuote.mint === t.mint && lastQuote.route.priceImpactPct != null ? `${lastQuote.route.priceImpactPct.toFixed(2)}%` : "—"]);
}

const refreshTicket = () => (busy ? undefined : mode === "send" ? previewSend() : previewSwap());

// --- network + market ----------------------------------------------------------------------------

async function checkNetwork() {
  try {
    const slot = await connection.getSlot();
    tick(ui.statSlot, slot.toLocaleString("en-US"));
    ui.netBadge.textContent = "Cookie Chain mainnet · live";
    ui.liveDot.classList.add("is-live");
  } catch {
    ui.netBadge.textContent = "RPC unreachable, retrying…";
    ui.liveDot.classList.remove("is-live");
  }
}

function renderTicker() {
  const items = [
    h("span", { class: "ticker-item" }, h("b", {}, "COOK"), fmtPrice(cookUsd)),
    ...tokens.slice(0, 18).map((t) =>
      h("span", { class: "ticker-item" }, h("b", {}, t.symbol), fmtPrice(t.priceUsd), h("span", { class: "up" }, `liq ${fmtUsd(t.liquidityUsd)}`)),
    ),
  ];
  // Two identical halves so the -50% loop is seamless.
  ui.tickerTrack.replaceChildren(...items, ...items.map((n) => n.cloneNode(true)));
  ui.tickerTrack.style.setProperty("--ticker-duration", `${Math.max(30, items.length * 4)}s`);
}

function renderShelf() {
  const top = tokens.slice(0, 12);
  const max = Math.max(...top.map((t) => t.liquidityUsd), 1);
  ui.shelfList.replaceChildren(
    ...top.map((t, i) => {
      const swapBtn = h("button", { class: "btn btn-gold btn-sm", type: "button" }, "Swap");
      swapBtn.addEventListener("click", () => {
        setMode("swap");
        ui.swapToken.value = t.mint;
        void refreshQuote();
        document.getElementById("counter")?.scrollIntoView({ behavior: "smooth" });
      });
      return h(
        "li",
        { class: "shelf-row", style: `animation: rise .6s ${i * 0.04}s var(--ease-out) both` },
        h("div", { class: "shelf-name" }, h("a", { href: explorerToken(t.mint), target: "_blank", rel: "noopener" }, t.symbol), h("small", {}, `${t.pools} pool${t.pools === 1 ? "" : "s"}`)),
        h("span", { class: "shelf-price" }, fmtPrice(t.priceUsd)),
        h("div", { class: "shelf-liq" }, h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `--w:${Math.max(3, (t.liquidityUsd / max) * 100).toFixed(1)}%` })), `${fmtUsd(t.liquidityUsd)} liquidity`),
        swapBtn,
      );
    }),
  );
  ui.swapToken.replaceChildren(
    h("option", { value: "" }, "Choose a token…"),
    ...tokens.map((t) => h("option", { value: t.mint }, `${t.symbol} · ${fmtPrice(t.priceUsd)}`)),
  );
}

async function loadMarket() {
  ui.shelfList.replaceChildren(...Array.from({ length: 5 }, () => h("li", { class: "shelf-skeleton" })));
  [tokens, cookUsd] = await Promise.all([loadMarketTokens(), cookPriceUsd()]);
  tick(ui.statPrice, fmtPrice(cookUsd));
  tick(ui.statPairs, String(tokens.length));
  renderTicker();
  renderShelf();
}

// --- wallet --------------------------------------------------------------------------------------

async function refreshWallet() {
  if (!owner) return;
  cookBal = await cookBalance(owner);
  tick(ui.balCook, fmtAmount(cookBal));
  ui.balUsd.textContent = `≈ ${fmtUsd(cookUsd != null ? cookBal * cookUsd : null)}`;
  const mint = ui.swapToken.value;
  if (mint && mode === "swap") {
    const bal = await tokenBalance(owner, mint);
    ui.balUsd.textContent += ` · ${fmtAmount(bal)} ${tokenByMint(mint)?.symbol ?? ""}`;
  }
  ui.connectLabel.textContent = `${short(owner.toBase58())} · ${fmtAmount(cookBal)} COOK`;
}

function activityItem(ok: boolean, title: string, when: string, sig: string) {
  return h(
    "li",
    {},
    h("span", { class: `ico${ok ? "" : " bad"}` }, ok ? "✓" : "×"),
    h("span", { class: "what" }, h("b", {}, title), h("small", {}, when)),
    h("a", { href: explorerTx(sig), target: "_blank", rel: "noopener" }, short(sig)),
  );
}

async function loadActivity() {
  if (!owner) return;
  const sigs = await recentActivity(owner, 6);
  if (!sigs.length) return;
  ui.activity.replaceChildren(
    ...sigs.map((s) => activityItem(!s.err, s.memo ? s.memo.replace(/^\[\d+\]\s*/, "") : s.err ? "Failed transaction" : "Transaction", timeAgo(s.blockTime), s.signature)),
  );
}

function pushActivity(title: string, sig: string) {
  ui.activity.querySelector(".timeline-empty")?.remove();
  ui.activity.prepend(activityItem(true, title, "just now", sig));
}

async function connect() {
  if (owner) return;
  try {
    ui.connectBtn.classList.add("is-busy");
    owner = await connectNightly();
    const addr = owner.toBase58();
    document.body.classList.add("is-connected");
    ui.walletLine.textContent = addr;
    ui.sendBtn.textContent = "Sign & send";
    ui.swapBtn.textContent = "Swap";
    ui.sendBtn.disabled = false;
    ui.swapBtn.disabled = !ui.swapToken.value;
    ui.tgLink.href = `https://t.me/${BOT_USERNAME}?start=watch_${addr}`;
    ui.tgLink.hidden = false;
    toast("Nightly connected to Cookie Chain");
    onAccountChange(() => location.reload());
    await Promise.all([refreshWallet(), loadActivity()]);
  } catch (e) {
    toast((e as Error).message);
    setStatus((e as Error).message, "err");
  } finally {
    ui.connectBtn.classList.remove("is-busy");
  }
}

// --- send ----------------------------------------------------------------------------------------

async function previewRecipient() {
  const v = ui.sendTo.value.trim();
  delete ui.sendResolved.dataset.name;
  if (!v) {
    ui.sendResolved.textContent = "";
    return previewSend();
  }
  try {
    const r = await resolveRecipient(v);
    if (ui.sendTo.value.trim() !== v) return;
    ui.sendResolved.className = "hint ok";
    ui.sendResolved.textContent = r.name ? `${r.name} → ${r.address}` : "✓ valid Cookie Chain address";
    ui.sendResolved.dataset.name = r.name ?? short(r.address);
  } catch (e) {
    ui.sendResolved.className = "hint err";
    ui.sendResolved.textContent = (e as Error).message;
  }
  previewSend();
}

async function run(label: string, build: () => Promise<{ sig: string; title: string; done: string }>) {
  if (!owner) return void connect();
  if (busy) return;
  busy = true;
  const btn = mode === "send" ? ui.sendBtn : ui.swapBtn;
  btn.classList.add("is-busy");
  btn.disabled = true;
  resetTicket(true);
  setStage("build");
  try {
    const { sig, title, done } = await build();
    setStage("done");
    setStatus(done, "ok");
    stamp(true, sig);
    pushActivity(title, sig);
    toast(`${label} confirmed`);
    await refreshWallet();
  } catch (e) {
    setStage("failed");
    const msg = (e as Error).message;
    setStatus(/reject|denied|cancel/i.test(msg) ? "You declined the transaction in Nightly." : msg, "err");
    stamp(false);
  } finally {
    busy = false;
    btn.classList.remove("is-busy");
    btn.disabled = false;
  }
}

function send(ev: SubmitEvent) {
  ev.preventDefault();
  const amount = Number(ui.sendAmount.value);
  if (!(amount > 0)) return setStatus("Enter an amount above 0.", "err");
  void run("Transfer", async () => {
    const to = await resolveRecipient(ui.sendTo.value);
    const lamports = toRaw(amount, COOK_DECIMALS);
    const balance = BigInt(await connection.getBalance(owner!));
    if (lamports + 10_000n > balance) throw new Error(`Not enough COOK: the jar holds ${fmtAmount(Number(balance) / 1e9)}.`);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: owner!, blockhash, lastValidBlockHeight });
    tx.add(SystemProgram.transfer({ fromPubkey: owner!, toPubkey: new PublicKey(to.address), lamports }));
    const memo = ui.sendMemo.value.trim();
    if (memo) {
      tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: owner!, isSigner: true, isWritable: false }], data: Buffer.from(memo, "utf8") }));
    }
    const sig = await signSendConfirm(connection, tx, blockhash, lastValidBlockHeight, setStage);
    const label = to.name ?? short(to.address);
    const tip = memo.startsWith("cookiebot:tip:");
    return {
      sig,
      title: `${tip ? "Tipped" : "Sent"} ${fmtAmount(amount)} COOK → ${label}`,
      done: tip ? "Tip confirmed. The Telegram chat updates itself in a few seconds." : `${fmtAmount(amount)} COOK delivered to ${label}.`,
    };
  });
}

// --- swap ----------------------------------------------------------------------------------------

let quoteSeq = 0;

async function refreshQuote() {
  const mint = ui.swapToken.value;
  const amount = Number(ui.swapAmount.value);
  // Unconnected, the button stays live so it can open Nightly.
  ui.swapBtn.disabled = Boolean(owner) && (!mint || !(amount > 0));
  lastQuote = null;
  previewSwap();
  if (!mint || !(amount > 0)) {
    ui.swapQuote.className = "hint";
    ui.swapQuote.textContent = "Routed through the Cookiebox aggregator.";
    return;
  }
  const seq = ++quoteSeq;
  ui.swapQuote.className = "hint";
  ui.swapQuote.textContent = "Asking the aggregator for the best route…";
  try {
    const [route, decimals] = await Promise.all([quoteSwap(mint, toRaw(amount, COOK_DECIMALS)), mintDecimals(mint)]);
    if (seq !== quoteSeq) return;
    if (!route) {
      ui.swapQuote.className = "hint err";
      ui.swapQuote.textContent = "No route for this pair right now.";
      ui.swapBtn.disabled = true;
      return;
    }
    lastQuote = { route, decimals, mint };
    const sym = tokenByMint(mint)?.symbol ?? "";
    ui.swapQuote.className = "hint ok";
    ui.swapQuote.textContent = `≈ ${fmtAmount(fromRaw(route.netOutAmount, decimals))} ${sym} · min ${fmtAmount(fromRaw(route.minOutAmount, decimals))}`;
    previewSwap();
    if (owner) void refreshWallet();
  } catch (e) {
    if (seq !== quoteSeq) return;
    ui.swapQuote.className = "hint err";
    ui.swapQuote.textContent = (e as Error).message;
  }
}

function swap(ev: SubmitEvent) {
  ev.preventDefault();
  const mint = ui.swapToken.value;
  const amount = Number(ui.swapAmount.value);
  if (!mint || !(amount > 0)) return;
  void run("Swap", async () => {
    const [built, decimals] = await Promise.all([buildSwap(mint, toRaw(amount, COOK_DECIMALS), owner!), mintDecimals(mint)]);
    const sig = await signSendConfirm(connection, built.tx, built.blockhash, built.lastValidBlockHeight, setStage);
    const sym = tokenByMint(mint)?.symbol ?? "tokens";
    const got = fmtAmount(fromRaw(built.route.netOutAmount, decimals));
    return { sig, title: `Swapped ${fmtAmount(amount)} COOK → ~${got} ${sym}`, done: `~${got} ${sym} are in your jar.` };
  });
}

// --- tabs, menu, reveal --------------------------------------------------------------------------

function setMode(next: "send" | "swap") {
  if (busy || next === mode) return;
  mode = next;
  ui.tabs.dataset.mode = next;
  ui.tabSend.setAttribute("aria-selected", String(next === "send"));
  ui.tabSwap.setAttribute("aria-selected", String(next === "swap"));
  ui.sendForm.hidden = next !== "send";
  ui.swapForm.hidden = next !== "swap";
  resetTicket(true);
  refreshTicket();
}

function wireMenu() {
  document.querySelectorAll<HTMLButtonElement>(".menu button[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy!);
        toast(`Copied ${b.dataset.copy}`);
      } catch {
        toast("Copy failed — select the text manually");
      }
    }),
  );
}

function wireReveal() {
  const targets = document.querySelectorAll<HTMLElement>("main > section[id]");
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("is-in"), io.unobserve(e.target))),
    { threshold: 0.12 },
  );
  targets.forEach((t) => {
    t.setAttribute("data-reveal", "");
    io.observe(t);
  });
}

function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  const to = p.get("to");
  if (to) {
    ui.sendTo.value = to;
    ui.sendAmount.value = p.get("amount") ?? "";
    ui.sendMemo.value = p.get("memo") ?? "";
    if (ui.sendMemo.value.startsWith("cookiebot:tip:")) {
      ui.sendMemo.readOnly = true;
      ui.tipNote.textContent = `Tip for ${p.get("label") ?? short(to)} from Telegram. The chat confirms it automatically.`;
      ui.tipNote.hidden = false;
    }
    void previewRecipient();
    document.getElementById("counter")?.scrollIntoView();
  }
  const swapMint = p.get("swap");
  if (swapMint && tokenByMint(swapMint)) {
    setMode("swap");
    ui.swapToken.value = swapMint;
    void refreshQuote();
    document.getElementById("counter")?.scrollIntoView();
  }
}

// --- boot ----------------------------------------------------------------------------------------

ui.botCta.href = `https://t.me/${BOT_USERNAME}`;
// Before a wallet is connected the action buttons invite a connection instead of sitting disabled.
ui.sendBtn.disabled = false;
ui.swapBtn.disabled = false;
ui.sendBtn.textContent = "Connect Nightly to send";
ui.swapBtn.textContent = "Connect Nightly to swap";
for (const btn of [ui.sendBtn, ui.swapBtn]) {
  btn.addEventListener("click", (e) => {
    if (owner) return;
    e.preventDefault();
    void connect();
  });
}
ui.connectBtn.addEventListener("click", () => void connect());
ui.tabSend.addEventListener("click", () => setMode("send"));
ui.tabSwap.addEventListener("click", () => setMode("swap"));
ui.sendForm.addEventListener("submit", send);
ui.swapForm.addEventListener("submit", swap);
ui.sendTo.addEventListener("input", debounce(() => void previewRecipient(), 450));
ui.sendAmount.addEventListener("input", () => previewSend());
ui.sendMemo.addEventListener("input", () => previewSend());
ui.swapToken.addEventListener("change", () => void refreshQuote());
ui.swapAmount.addEventListener("input", debounce(() => void refreshQuote(), 400));
document.querySelectorAll<HTMLButtonElement>(".chip[data-amount]").forEach((chip) =>
  chip.addEventListener("click", () => {
    const v = chip.dataset.amount === "max" ? Math.max(0, cookBal - 0.01) : Number(chip.dataset.amount);
    ui.sendAmount.value = String(Number(v.toFixed(4)));
    previewSend();
  }),
);

newTicketNumber();
previewSend();
wireMenu();
wireReveal();
void startChatDemo(ui.chatDemo, ui.demoStatus);
void checkNetwork();
setInterval(() => void checkNetwork(), 6_000);
loadMarket()
  .catch((e) => {
    ui.shelfList.replaceChildren(h("li", { class: "timeline-empty" }, `Market data unavailable: ${(e as Error).message}`));
  })
  .finally(applyUrlParams);
