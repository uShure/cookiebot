const EXPLORER = "https://cookiescan.io";

export const explorerTx = (sig: string) => `${EXPLORER}/tx/${sig}`;
export const explorerAddress = (addr: string) => `${EXPLORER}/address/${addr}`;
export const explorerToken = (mint: string) => `${EXPLORER}/token/${mint}`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

// 1234567 → "1.23M"; small values keep significant digits instead of rounding to 0.
const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function fmtAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim((n / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${trim((n / 1e6).toFixed(2))}M`;
  if (abs >= 1e4) return `${trim((n / 1e3).toFixed(1))}K`;
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs === 0) return "0";
  return n.toPrecision(3);
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

// Cookie Chain prices are tiny. Below $0.001 use DEX notation: 0.00000079 → "$0.0₆790".
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n === 0) return "$0";
  if (n >= 0.001) return `$${n.toPrecision(3)}`;
  let zeros = Math.floor(-Math.log10(n));
  let digits = Math.round(n * 10 ** (zeros + 3));
  if (digits >= 1000) {
    digits = Math.round(digits / 10);
    zeros -= 1;
  }
  return `$0.0${String(zeros).replace(/\d/g, (d) => SUBSCRIPT[Number(d)])}${digits}`;
}

/** Parses "0.0001", "$0.0001", "1e-4" and "0,0001". Returns null for anything else. */
export function parsePrice(input: string): number | null {
  const n = Number(input.trim().replace(/^\$/, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parses "500", "1.5k", "2K", "1,000". */
export function parseAmount(input: string): number | null {
  const m = input.trim().toLowerCase().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
  return n > 0 ? n : null;
}

export function utcTime(d = new Date()): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// HTML-safe: every consumer is a Telegram HTML message, where a bare "<" breaks parsing.
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 0.01) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return n === 0 ? "$0" : "&lt;$0.01";
}

export function fmtChange(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "";
  const sign = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return `${sign} ${Math.abs(pct).toFixed(1)}%`;
}
