export function fmtAmount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 1 || a === 0) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

// Cookie Chain prices are tiny. Below $0.001 use DEX notation: 0.00000079 → "$0.0₆790".
export function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  if (n >= 0.001) return `$${n.toPrecision(3)}`;
  let zeros = Math.floor(-Math.log10(n));
  let digits = Math.round(n * 10 ** (zeros + 3));
  if (digits >= 1000) {
    digits = Math.round(digits / 10);
    zeros -= 1;
  }
  const sub = String(zeros).replace(/\d/g, (d) => SUBSCRIPT[Number(d)]);
  return `$0.0${sub}${digits}`;
}

export function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

export function timeAgo(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "pending";
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type Child = Node | string | null | undefined | false;

/** Tiny DOM builder; text always goes through textContent, never innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
