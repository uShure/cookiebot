# 🍪 CookieBot — Cookie Chain in your Telegram

CookieBot brings [Cookie Chain](https://www.cookiechain.wtf) to where communities already are: Telegram.
A bot watches wallets and prices in real time and lets people tip each other in COOK right inside a group chat,
while a companion web app handles everything that needs a signature in the [Nightly](https://nightly.app) wallet.

- **Web app:** https://ushure.github.io/cookiebot/
- **Telegram bot:** [@cookiechain_bot](https://t.me/cookiechain_bot)
- Built for the Superteam Earn bounty [Create an App on Cookie Chain](https://superteam.fun/earn/listing/create-an-app-on-cookie-chain-app/)

## What it does

### Telegram bot
| Command | What happens on Cookie Chain |
| --- | --- |
| `/watch <address or name.cook> [label]` | Opens a `logsSubscribe` WebSocket subscription for the wallet. Every transfer, swap or failed tx is decoded into balance changes (COOK and SPL/Token-2022) with USD values and posted to the chat within seconds. |
| `/tip <name.cook> <amount>` | Posts a tip request with a **Pay with Nightly** button. The payment carries a unique memo; the bot finds it on-chain and edits the message to ✅ with the Cookiescan link. |
| `/alert <SYMBOL> above/below <price>` | Price alerts evaluated against Cookiescan market data. |
| `/portfolio <address or name.cook>` | Native COOK + every token account, priced in USD. |
| `/price <SYMBOL>`, `/top` | Token price, 24h change, holders, liquidity; top tokens by liquidity. |
| `/send`, `/swap` | Deep links into the web app with the transaction pre-filled. |

`.cook` names are resolved directly from the CookOven `cookie_domains` program, and names listed on the `.cook`
marketplace are refused so funds are never sent to the market escrow.

### Web app (Nightly)
- **Connect Nightly** — asks Nightly to switch to Cookie Chain (`changeNetwork` with the chain's genesis hash + RPC) and shows the connected address, COOK balance and recent activity.
- **Send / Tip** — native COOK transfer with an optional SPL Memo, recipient as address or `name.cook`, balance check, and staged feedback: *approve in Nightly → broadcasting → confirming → confirmed* with an explorer link, or a readable error.
- **Swap** — COOK → any token through the **Cookiebox aggregator** (`agg.cookiebox.app`): live quote with fee, price impact, minimum received and route venues; the aggregator returns an unsigned v0 transaction that is signed in Nightly and broadcast through the Cookie Chain RPC.
- **Market** — top tokens by liquidity from the Cookiescan markets feed.
- **Get live alerts in Telegram** — one tap opens the bot and subscribes it to the connected wallet.

Everything is non-custodial: transactions are built in the browser, signed in Nightly and sent through `rpc.cookiescan.io`, so a wallet still pointed at Solana cannot broadcast to the wrong network.

## Cookie Chain integrations
| Integration | Used for |
| --- | --- |
| RPC `https://rpc.cookiescan.io` / WS `wss://rpc.cookiescan.io` | balances, token accounts, transactions, `logsSubscribe` alerts, signature + memo lookup |
| Cookiescan API (`api.cookiescan.io`) | token registry, markets, COOK/USD price |
| Cookiebox aggregator (`agg.cookiebox.app`) | swap quotes and swap transactions |
| CookOven `cookie_domains` program | `.cook` name → wallet resolution |
| SPL Memo program | tip matching between Telegram and on-chain payments |

## Architecture

```
Telegram ──► bot (grammY, Node) ──► Cookie Chain RPC + WebSocket
               │   SQLite: watches, price alerts, tips
               └─ deep links ─► web app (Vite, static) ──► Nightly ──► Cookie Chain RPC
                                        └─► Cookiebox aggregator, Cookiescan API
```

- `bot/` — TypeScript, [grammY](https://grammy.dev), `@solana/web3.js`, `node:sqlite`; runs with `tsx`.
- `web/` — TypeScript + Vite, no framework, no backend (all three Cookie Chain hosts allow CORS). Deployed to GitHub Pages by `.github/workflows/pages.yml`.

## Run it yourself

Requirements: Node.js ≥ 22.

### Bot
```bash
cd bot
cp .env.example .env        # set BOT_TOKEN from @BotFather and WEB_APP_URL
npm install
npm run smoke               # read-only checks against Cookie Chain
npm run dev
```

With Docker (what the hosted bot uses):
```bash
cd bot && cp .env.example .env   # fill it in
docker compose up -d --build
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | — | Telegram bot token |
| `WEB_APP_URL` | `http://localhost:5173` | Public URL of the web app (Telegram needs https for buttons) |
| `COOKIE_RPC_URL` / `COOKIE_WS_URL` | `https://rpc.cookiescan.io` / `wss://rpc.cookiescan.io` | Cookie Chain endpoints |
| `COOKIESCAN_API_URL` | `https://api.cookiescan.io` | Token registry, markets, prices |
| `DB_PATH` | `./cookiebot.db` | SQLite file |
| `PRICE_CHECK_SECONDS` | `60` | Price alert interval |

### Web app
```bash
cd web
npm install
echo "VITE_BOT_USERNAME=your_bot_username" > .env
npm run dev        # http://localhost:5173
npm run build      # static output in web/dist
```

## Getting COOK
Bridge COOK from Solana 1:1 at [hyperlane.cookiescan.io](https://hyperlane.cookiescan.io), then connect Nightly. Network fees on Cookie Chain are fractions of a cent.

## License
MIT
