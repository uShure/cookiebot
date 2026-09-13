// Live read-only checks against Cookie Chain: `npm run smoke`.
import { connection, describeWalletTx, findToken, getPortfolio, resolveWallet, topTokens } from "../src/chain.js";
import { fmtAmount, fmtPrice, fmtUsd } from "../src/format.js";

const SAMPLE_HOLDER = process.argv[2] ?? "AuCPPPDywCr9tq3LrYC4cGM5mpfYpZy1ZKYhshZvPtFj";

async function step(name: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`✔ ${name} (${Date.now() - t} ms)`, out ?? "");
  } catch (e) {
    console.log(`✘ ${name}:`, (e as Error).message);
  }
}

await step("COOK price", async () => fmtPrice((await findToken("COOK"))?.priceUsd));
await step("bCOOK by symbol", async () => {
  const t = await findToken("bCOOK");
  return t && `${t.mint} ${fmtPrice(t.priceUsd)} holders=${t.holders}`;
});
await step("top tokens", async () => (await topTokens(5)).map((t) => `${t.symbol}:${fmtPrice(t.priceUsd)}`).join(", "));
await step("portfolio", async () => {
  const p = await getPortfolio(SAMPLE_HOLDER);
  return `COOK=${fmtAmount(p.cook)} tokens=${p.tokens.length} total=${fmtUsd(p.totalUsd)} top=${p.tokens.slice(0, 3).map((t) => `${fmtAmount(t.amount)} ${t.symbol}`).join(", ")}`;
});
await step("last tx effect", async () => {
  const [sig] = await connection.getSignaturesForAddress(new (await import("@solana/web3.js")).PublicKey(SAMPLE_HOLDER), { limit: 1 });
  if (!sig) return "no txs";
  const e = await describeWalletTx(sig.signature, SAMPLE_HOLDER);
  return e && `${sig.signature.slice(0, 12)}… failed=${e.failed} memo=${e.memo} changes=${JSON.stringify(e.changes)}`;
});
await step("resolve address", async () => (await resolveWallet(SAMPLE_HOLDER)).address);
for (const name of ["cookie.cook", "bot.cook", "gorbagana.cook", "definitely-not-registered-xyz.cook"]) {
  await step(`resolve ${name}`, async () => JSON.stringify(await resolveWallet(name)));
}
process.exit(0);
