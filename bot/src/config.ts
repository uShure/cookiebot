import "dotenv/config";

function env(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v.replace(/\/$/, "") : fallback;
}

export const config = {
  rpcUrl: env("COOKIE_RPC_URL", "https://rpc.cookiescan.io"),
  wsUrl: env("COOKIE_WS_URL", "wss://rpc.cookiescan.io"),
  cookiescanApi: env("COOKIESCAN_API_URL", "https://api.cookiescan.io"),
  webAppUrl: env("WEB_APP_URL", "http://localhost:5173"),
  dbPath: env("DB_PATH", "./cookiebot.db"),
  priceCheckSeconds: Number(env("PRICE_CHECK_SECONDS", "60")) || 60,
};

// Read lazily so chain helpers and scripts work without a bot token.
export function botToken(): string {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) throw new Error("BOT_TOKEN is not set — copy .env.example to .env and fill it in");
  return token;
}
