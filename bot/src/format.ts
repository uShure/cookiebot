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
export function fmtAmount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs === 0) return "0";
  return n.toPrecision(3);
}

// Cookie Chain prices are often fractions of a cent: $0.00007034, not $0.00.
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n === 0) return "$0";
  return `$${n.toPrecision(4)}`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 0.01) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return n === 0 ? "$0" : "<$0.01";
}

export function fmtChange(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "";
  const sign = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return `${sign} ${Math.abs(pct).toFixed(1)}%`;
}
