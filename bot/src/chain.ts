// Cookie Chain reads: markets, token registry, .cook names, balances and per-wallet tx effects.
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

import { config } from "./config.js";

export const COOK_MINT = "So11111111111111111111111111111111111111112";
export const COOK_DECIMALS = 9;
const LAMPORTS = 10 ** COOK_DECIMALS;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const DOMAINS_PROGRAM = new PublicKey("H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA");
const DOMAINS_MARKET_PROGRAM = new PublicKey("Ey35mr69UfiQqZSwD2qYAZoMNfnuVJGCjwNSB64ppHm7");
const DOMAIN_DISC = Buffer.from([35, 146, 98, 112, 13, 230, 231, 153]);

export const connection = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: config.wsUrl,
});

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let pending: Promise<T> | null = null;
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value;
    pending ??= load()
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .finally(() => {
        pending = null;
      });
    // Serve stale data if a refresh fails.
    try {
      return await pending;
    } catch (e) {
      if (value !== undefined) return value;
      throw e;
    }
  };
}

// --- Token registry + prices ---------------------------------------------------------------------

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  change24h: number | null;
  liquidityCook: number;
  holders: number;
}

interface RawToken {
  mint: string;
  metadata?: { name?: string; symbol?: string; decimals?: number };
  price?: { usd?: string | number; change24h?: number };
  marketData?: { liquidity?: number; holderCount?: number };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ~6.5k tokens / ~4 MB, so refresh every 5 minutes, not per command.
export const getRegistry = cached(5 * 60_000, async () => {
  const json = await getJson<{ data?: RawToken[] }>(`${config.cookiescanApi}/api/tokens`, 60_000);
  const byMint = new Map<string, TokenInfo>();
  for (const t of json.data ?? []) {
    if (!t.mint) continue;
    byMint.set(t.mint, {
      mint: t.mint,
      symbol: t.metadata?.symbol?.trim() || "?",
      name: t.metadata?.name?.trim() || "",
      decimals: t.metadata?.decimals ?? 0,
      priceUsd: num(t.price?.usd),
      change24h: num(t.price?.change24h),
      liquidityCook: t.marketData?.liquidity ?? 0,
      holders: t.marketData?.holderCount ?? 0,
    });
  }
  return byMint;
});

export const getCookPriceUsd = cached(30_000, async () => {
  const json = await getJson<{ data?: { price?: { usd?: number } } }>(
    `${config.cookiescanApi}/api/price/cook`,
  );
  return num(json.data?.price?.usd);
});

/** Find a token by mint or symbol. Symbols collide on memecoin chains, so the deepest pool wins. */
export async function findToken(query: string): Promise<TokenInfo | null> {
  const q = query.trim();
  const registry = await getRegistry();
  if (/^(w?cook)$/i.test(q)) {
    const cook = registry.get(COOK_MINT);
    const price = await getCookPriceUsd();
    return {
      mint: COOK_MINT,
      symbol: "COOK",
      name: "Cookie Chain native token",
      decimals: COOK_DECIMALS,
      priceUsd: price ?? cook?.priceUsd ?? null,
      change24h: cook?.change24h ?? null,
      liquidityCook: cook?.liquidityCook ?? 0,
      holders: cook?.holders ?? 0,
    };
  }
  const exact = registry.get(q);
  if (exact) return exact;
  let best: TokenInfo | null = null;
  for (const t of registry.values()) {
    if (t.symbol.toLowerCase() !== q.toLowerCase()) continue;
    if (!best || t.liquidityCook > best.liquidityCook) best = t;
  }
  return best;
}

export async function topTokens(limit = 10): Promise<TokenInfo[]> {
  const registry = await getRegistry();
  return [...registry.values()]
    .filter((t) => t.mint !== COOK_MINT && t.liquidityCook > 0 && t.priceUsd != null)
    .sort((a, b) => b.liquidityCook - a.liquidityCook)
    .slice(0, limit);
}

// --- .cook names ---------------------------------------------------------------------------------

const [MARKET_ESCROW] = PublicKey.findProgramAddressSync(
  [Buffer.from("escrow_authority")],
  DOMAINS_MARKET_PROGRAM,
);

export function looksLikeName(input: string): boolean {
  const s = input.trim();
  return s.toLowerCase().endsWith(".cook") || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export interface ResolvedWallet {
  address: string;
  name: string | null;
}

/** Accepts a base58 address or a `.cook` name. Throws a user-readable Error. */
export async function resolveWallet(input: string): Promise<ResolvedWallet> {
  const raw = input.trim();
  if (!looksLikeName(raw)) {
    try {
      return { address: new PublicKey(raw).toBase58(), name: null };
    } catch {
      throw new Error("That doesn't look like a Cookie Chain address.");
    }
  }
  const lower = raw.toLowerCase();
  const label = lower.endsWith(".cook") ? lower.slice(0, -5) : lower;
  if (!/^[a-z0-9-]{1,32}$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
    throw new Error(`"${raw}" is not a valid address or .cook name.`);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("domain"), Buffer.from(label, "utf8")],
    DOMAINS_PROGRAM,
  );
  const info = await connection.getAccountInfo(pda);
  if (!info || !info.data.subarray(0, 8).equals(DOMAIN_DISC)) {
    throw new Error(`${label}.cook is not registered.`);
  }
  const end = 12 + info.data.readUInt32LE(8);
  const owner = new PublicKey(info.data.subarray(end, end + 32));
  if (owner.equals(MARKET_ESCROW)) {
    throw new Error(`${label}.cook is listed on the .cook market, so it has no wallet right now.`);
  }
  return { address: owner.toBase58(), name: `${label}.cook` };
}

// --- Balances ------------------------------------------------------------------------------------

export interface Holding {
  mint: string;
  symbol: string;
  amount: number;
  usd: number | null;
}

export interface Portfolio {
  cook: number;
  cookUsd: number | null;
  tokens: Holding[];
  totalUsd: number | null;
}

export async function getPortfolio(address: string): Promise<Portfolio> {
  const owner = new PublicKey(address);
  const [lamports, spl, spl2022, registry, cookPrice] = await Promise.all([
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM }),
    getRegistry(),
    getCookPriceUsd(),
  ]);

  const byMint = new Map<string, number>();
  for (const { account } of [...spl.value, ...spl2022.value]) {
    const info = account.data.parsed.info as { mint: string; tokenAmount: { uiAmount: number | null } };
    const amount = info.tokenAmount.uiAmount ?? 0;
    if (amount > 0) byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amount);
  }

  const tokens: Holding[] = [...byMint].map(([mint, amount]) => {
    const t = registry.get(mint);
    const price = mint === COOK_MINT ? cookPrice : (t?.priceUsd ?? null);
    return {
      mint,
      symbol: mint === COOK_MINT ? "wCOOK" : (t?.symbol ?? "?"),
      amount,
      usd: price != null ? amount * price : null,
    };
  });
  tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  const cook = lamports / LAMPORTS;
  const cookUsd = cookPrice != null ? cook * cookPrice : null;
  const priced = tokens.filter((t) => t.usd != null);
  const totalUsd =
    cookUsd != null || priced.length ? (cookUsd ?? 0) + priced.reduce((s, t) => s + t.usd!, 0) : null;
  return { cook, cookUsd, tokens, totalUsd };
}

// --- What a transaction did to one wallet --------------------------------------------------------

export interface BalanceChange {
  mint: string;
  symbol: string;
  delta: number;
}

export interface WalletTxEffect {
  signature: string;
  failed: boolean;
  blockTime: number | null;
  memo: string | null;
  changes: BalanceChange[];
  /** The other side of the main balance change, when one can be identified. */
  counterparty: string | null;
}

export function memoOf(tx: ParsedTransactionWithMeta): string | null {
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId.toBase58() === MEMO_PROGRAM && "parsed" in ix && typeof ix.parsed === "string") {
      return ix.parsed;
    }
  }
  return null;
}

export async function describeWalletTx(signature: string, wallet: string): Promise<WalletTxEffect | null> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) return null;
  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const changes: BalanceChange[] = [];

  const idx = keys.indexOf(wallet);
  if (idx >= 0) {
    // Report the transfer itself, not the network fee the wallet paid for it.
    const fee = idx === 0 ? meta.fee : 0;
    const delta = (meta.postBalances[idx] - meta.preBalances[idx] + fee) / LAMPORTS;
    if (Math.abs(delta) >= 1e-6) changes.push({ mint: COOK_MINT, symbol: "COOK", delta });
  }

  const registry = await getRegistry();
  const tokenDeltas = new Map<string, number>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner === wallet) tokenDeltas.set(b.mint, (tokenDeltas.get(b.mint) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0));
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner === wallet) tokenDeltas.set(b.mint, (tokenDeltas.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
  }
  for (const [mint, delta] of tokenDeltas) {
    if (Math.abs(delta) < 1e-9) continue;
    const symbol = mint === COOK_MINT ? "wCOOK" : (registry.get(mint)?.symbol ?? "?");
    changes.push({ mint, symbol, delta });
  }

  // Counterparty: the account whose balance of the same asset moved the opposite way the most.
  let counterparty: string | null = null;
  const main = changes[0];
  if (main) {
    let best = 0;
    if (main.symbol === "COOK") {
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === wallet) continue;
        const d = meta.postBalances[i] - meta.preBalances[i];
        if (Math.sign(d) === -Math.sign(main.delta) && Math.abs(d) > best) {
          best = Math.abs(d);
          counterparty = keys[i];
        }
      }
    } else {
      const byOwner = new Map<string, number>();
      for (const b of meta.preTokenBalances ?? []) {
        if (b.mint === main.mint && b.owner && b.owner !== wallet) byOwner.set(b.owner, (byOwner.get(b.owner) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0));
      }
      for (const b of meta.postTokenBalances ?? []) {
        if (b.mint === main.mint && b.owner && b.owner !== wallet) byOwner.set(b.owner, (byOwner.get(b.owner) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
      }
      for (const [owner, d] of byOwner) {
        if (Math.sign(d) === -Math.sign(main.delta) && Math.abs(d) > best) {
          best = Math.abs(d);
          counterparty = owner;
        }
      }
    }
  }

  return { signature, failed: meta.err != null, blockTime: tx.blockTime ?? null, memo: memoOf(tx), changes, counterparty };
}
