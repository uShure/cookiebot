// Cookie Chain data for the browser: RPC, Cookiescan markets, Cookiebox aggregator, .cook names.
// All three hosts send permissive CORS headers, so the app needs no backend.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

export const RPC_URL = "https://rpc.cookiescan.io";
export const GENESIS_HASH = "9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2";
const COOKIESCAN_API = "https://api.cookiescan.io";
const AGG_API = "https://agg.cookiebox.app";
export const COOK_MINT = "So11111111111111111111111111111111111111112";
export const COOK_DECIMALS = 9;
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DOMAINS_PROGRAM = new PublicKey("H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA");
const DOMAINS_MARKET_PROGRAM = new PublicKey("Ey35mr69UfiQqZSwD2qYAZoMNfnuVJGCjwNSB64ppHm7");
const DOMAIN_DISC = [35, 146, 98, 112, 13, 230, 231, 153];
const enc = new TextEncoder();

export const connection = new Connection(RPC_URL, "confirmed");
export const explorerTx = (sig: string) => `https://cookiescan.io/tx/${sig}`;
export const explorerToken = (mint: string) => `https://cookiescan.io/token/${mint}`;

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

// --- Markets -------------------------------------------------------------------------------------

export interface MarketToken {
  mint: string;
  symbol: string;
  priceUsd: number | null;
  liquidityUsd: number;
  pools: number;
}

interface RawMarket {
  liquidityUsd?: number;
  baseToken: { mint: string; symbol?: string; priceUsd?: number };
  quoteToken: { mint: string; symbol?: string; priceUsd?: number };
}

/** Tokens tradeable against COOK, deepest first (from the 70 KB markets feed, not the 4 MB registry). */
export async function loadMarketTokens(): Promise<MarketToken[]> {
  // The feed puts the list under `markets` (older deploys used `data`).
  const json = await getJson<{ markets?: RawMarket[]; data?: RawMarket[] }>(`${COOKIESCAN_API}/api/markets`);
  const byMint = new Map<string, MarketToken>();
  for (const m of json.markets ?? json.data ?? []) {
    const sides = [m.baseToken, m.quoteToken];
    if (!sides.some((s) => s.mint === COOK_MINT)) continue;
    const other = sides.find((s) => s.mint !== COOK_MINT);
    if (!other) continue;
    const t = byMint.get(other.mint) ?? { mint: other.mint, symbol: other.symbol ?? "?", priceUsd: null, liquidityUsd: 0, pools: 0 };
    t.liquidityUsd += m.liquidityUsd ?? 0;
    t.pools += 1;
    if (other.priceUsd != null && Number.isFinite(other.priceUsd)) t.priceUsd = other.priceUsd;
    byMint.set(other.mint, t);
  }
  return [...byMint.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

export async function cookPriceUsd(): Promise<number | null> {
  const json = await getJson<{ data?: { price?: { usd?: number } } }>(`${COOKIESCAN_API}/api/price/cook`).catch(() => null);
  return json?.data?.price?.usd ?? null;
}

// --- .cook names ---------------------------------------------------------------------------------

export interface Recipient {
  address: string;
  name: string | null;
}

export async function resolveRecipient(input: string): Promise<Recipient> {
  const raw = input.trim();
  const isName = raw.toLowerCase().endsWith(".cook") || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
  if (!isName) return { address: new PublicKey(raw).toBase58(), name: null };

  const lower = raw.toLowerCase();
  const label = lower.endsWith(".cook") ? lower.slice(0, -5) : lower;
  if (!/^[a-z0-9-]{1,32}$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
    throw new Error("Not a valid address or .cook name");
  }
  const [pda] = PublicKey.findProgramAddressSync([enc.encode("domain"), enc.encode(label)], DOMAINS_PROGRAM);
  const info = await connection.getAccountInfo(pda);
  if (!info || DOMAIN_DISC.some((b, i) => info.data[i] !== b)) throw new Error(`${label}.cook is not registered`);
  const data = info.data;
  const nameLen = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, true);
  const owner = new PublicKey(data.slice(12 + nameLen, 12 + nameLen + 32));
  const [escrow] = PublicKey.findProgramAddressSync([enc.encode("escrow_authority")], DOMAINS_MARKET_PROGRAM);
  if (owner.equals(escrow)) throw new Error(`${label}.cook is listed on the market — sending would strand funds`);
  return { address: owner.toBase58(), name: `${label}.cook` };
}

// --- Wallet reads --------------------------------------------------------------------------------

const decimalsCache = new Map<string, number>([[COOK_MINT, COOK_DECIMALS]]);

export async function mintDecimals(mint: string): Promise<number> {
  const hit = decimalsCache.get(mint);
  if (hit != null) return hit;
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const parsed = info.value?.data && "parsed" in info.value.data ? info.value.data.parsed : null;
  const decimals = (parsed as { info?: { decimals?: number } } | null)?.info?.decimals;
  if (decimals == null) throw new Error("Could not read token decimals");
  decimalsCache.set(mint, decimals);
  return decimals;
}

export async function cookBalance(owner: PublicKey): Promise<number> {
  return (await connection.getBalance(owner)) / 10 ** COOK_DECIMALS;
}

export async function tokenBalance(owner: PublicKey, mint: string): Promise<number> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return res.value.reduce((sum, a) => sum + ((a.account.data.parsed.info.tokenAmount.uiAmount as number | null) ?? 0), 0);
}

export async function recentActivity(owner: PublicKey, limit = 8) {
  return connection.getSignaturesForAddress(owner, { limit });
}

// --- Cookiebox aggregator ------------------------------------------------------------------------

export interface AggRoute {
  inAmount: string;
  outAmount: string;
  netOutAmount: string;
  minOutAmount: string;
  feePct: number;
  priceImpactPct: number | null;
  path: string[];
  segments: { venue: string; pool: string }[];
}

export function toRaw(ui: number, decimals: number): bigint {
  const [whole, frac = ""] = ui.toFixed(decimals).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

export function fromRaw(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** COOK → token quote. Returns null when there is no route. */
export async function quoteSwap(outputMint: string, amountRaw: bigint, slippageBps = 100): Promise<AggRoute | null> {
  const q = new URLSearchParams({ inputMint: COOK_MINT, outputMint, amount: amountRaw.toString(), slippageBps: String(slippageBps) });
  try {
    return (await getJson<{ route: AggRoute }>(`${AGG_API}/quote?${q}`)).route;
  } catch (e) {
    if (/404|no route/i.test((e as Error).message)) return null;
    throw e;
  }
}

export interface BuiltSwap {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  route: AggRoute;
}

/** The aggregator re-quotes and returns an unsigned v0 tx with our wallet as fee payer. */
export async function buildSwap(outputMint: string, amountRaw: bigint, owner: PublicKey, slippageBps = 100): Promise<BuiltSwap> {
  const built = await getJson<{ transactionBase64: string; blockhash: string; lastValidBlockHeight: number; route: AggRoute }>(
    `${AGG_API}/swap-tx`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputMint: COOK_MINT, outputMint, amount: amountRaw.toString(), slippageBps, owner: owner.toBase58() }),
    },
    60_000,
  );
  const bytes = Uint8Array.from(atob(built.transactionBase64), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(bytes);
  if (!tx.message.staticAccountKeys[0]?.equals(owner)) throw new Error("Aggregator returned a tx with an unexpected fee payer");
  return { tx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight, route: built.route };
}
