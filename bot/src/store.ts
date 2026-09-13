// SQLite persistence (node:sqlite, no native build step): linked wallets, watches, price alerts, tips.
import { DatabaseSync } from "node:sqlite";

import { config } from "./config.js";

const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS watches (
    chat_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, address)
  );
  CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    mint TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    target REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    message_id INTEGER,
    from_name TEXT NOT NULL,
    to_address TEXT NOT NULL,
    to_label TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    signature TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_wallets (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    address TEXT NOT NULL,
    name TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_wallets_username ON user_wallets (lower(username));
`);

// Columns added after the first deploy; ALTER is a no-op error when they already exist.
for (const ddl of ["ALTER TABLE tips ADD COLUMN creator_id INTEGER"]) {
  try {
    db.exec(ddl);
  } catch {
    /* column exists */
  }
}

const now = () => Math.floor(Date.now() / 1000);

// --- Linked wallets ------------------------------------------------------------------------------

export interface UserWallet {
  user_id: number;
  username: string | null;
  address: string;
  name: string | null;
}

export function linkWallet(userId: number, username: string | undefined, address: string, name: string | null): void {
  db.prepare(
    `INSERT INTO user_wallets (user_id, username, address, name, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, address = excluded.address, name = excluded.name, updated_at = excluded.updated_at`,
  ).run(userId, username ?? null, address, name, now());
}

export function unlinkWallet(userId: number): boolean {
  return db.prepare("DELETE FROM user_wallets WHERE user_id = ?").run(userId).changes > 0;
}

export function walletOfUser(userId: number): UserWallet | null {
  return (db.prepare("SELECT user_id, username, address, name FROM user_wallets WHERE user_id = ?").get(userId) as unknown as UserWallet) ?? null;
}

export function walletOfUsername(username: string): UserWallet | null {
  const clean = username.replace(/^@/, "").toLowerCase();
  return (db.prepare("SELECT user_id, username, address, name FROM user_wallets WHERE lower(username) = ?").get(clean) as unknown as UserWallet) ?? null;
}

/** Keep the stored @username fresh so /tip @name keeps working after renames. */
export function touchUsername(userId: number, username: string | undefined): void {
  db.prepare("UPDATE user_wallets SET username = ? WHERE user_id = ? AND coalesce(username, '') <> coalesce(?, '')").run(username ?? null, userId, username ?? null);
}

// --- Watches -------------------------------------------------------------------------------------

export interface Watch {
  chat_id: number;
  address: string;
  label: string | null;
}

export function addWatch(chatId: number, address: string, label: string | null): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO watches (chat_id, address, label, created_at) VALUES (?, ?, ?, ?)")
    .run(chatId, address, label, now());
  return r.changes > 0;
}

export function renameWatch(chatId: number, address: string, label: string): boolean {
  return db.prepare("UPDATE watches SET label = ? WHERE chat_id = ? AND address = ?").run(label, chatId, address).changes > 0;
}

export function removeWatch(chatId: number, address: string): boolean {
  return db.prepare("DELETE FROM watches WHERE chat_id = ? AND address = ?").run(chatId, address).changes > 0;
}

export function getWatch(chatId: number, address: string): Watch | null {
  return (db.prepare("SELECT chat_id, address, label FROM watches WHERE chat_id = ? AND address = ?").get(chatId, address) as unknown as Watch) ?? null;
}

export function watchesForChat(chatId: number): Watch[] {
  return db.prepare("SELECT chat_id, address, label FROM watches WHERE chat_id = ? ORDER BY created_at").all(chatId) as unknown as Watch[];
}

export function watchersOf(address: string): Watch[] {
  return db.prepare("SELECT chat_id, address, label FROM watches WHERE address = ?").all(address) as unknown as Watch[];
}

export function watchedAddresses(): string[] {
  return (db.prepare("SELECT DISTINCT address FROM watches").all() as { address: string }[]).map((r) => r.address);
}

// --- Price alerts --------------------------------------------------------------------------------

export interface PriceAlert {
  id: number;
  chat_id: number;
  mint: string;
  symbol: string;
  direction: "above" | "below";
  target: number;
}

export function addPriceAlert(a: Omit<PriceAlert, "id">): number {
  const r = db
    .prepare("INSERT INTO price_alerts (chat_id, mint, symbol, direction, target, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(a.chat_id, a.mint, a.symbol, a.direction, a.target, now());
  return Number(r.lastInsertRowid);
}

export function priceAlertsForChat(chatId: number): PriceAlert[] {
  return db.prepare("SELECT * FROM price_alerts WHERE chat_id = ? ORDER BY id").all(chatId) as unknown as PriceAlert[];
}

export function allPriceAlerts(): PriceAlert[] {
  return db.prepare("SELECT * FROM price_alerts").all() as unknown as PriceAlert[];
}

export function deletePriceAlert(id: number, chatId?: number): boolean {
  const r = chatId == null
    ? db.prepare("DELETE FROM price_alerts WHERE id = ?").run(id)
    : db.prepare("DELETE FROM price_alerts WHERE id = ? AND chat_id = ?").run(id, chatId);
  return r.changes > 0;
}

// --- Tips ----------------------------------------------------------------------------------------

export interface Tip {
  id: string;
  chat_id: number;
  message_id: number | null;
  creator_id: number | null;
  from_name: string;
  to_address: string;
  to_label: string;
  amount: number;
  status: "pending" | "paid" | "expired" | "cancelled";
  signature: string | null;
  created_at: number;
}

export function createTip(t: Pick<Tip, "id" | "chat_id" | "creator_id" | "from_name" | "to_address" | "to_label" | "amount">): void {
  db.prepare("INSERT INTO tips (id, chat_id, creator_id, from_name, to_address, to_label, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(t.id, t.chat_id, t.creator_id, t.from_name, t.to_address, t.to_label, t.amount, now());
}

export function getTip(id: string): Tip | null {
  return (db.prepare("SELECT * FROM tips WHERE id = ?").get(id) as unknown as Tip) ?? null;
}

export function setTipMessage(id: string, messageId: number): void {
  db.prepare("UPDATE tips SET message_id = ? WHERE id = ?").run(messageId, id);
}

export function pendingTips(): Tip[] {
  return db.prepare("SELECT * FROM tips WHERE status = 'pending'").all() as unknown as Tip[];
}

export function markTip(id: string, status: Tip["status"], signature: string | null = null): boolean {
  return db.prepare("UPDATE tips SET status = ?, signature = ? WHERE id = ? AND status = 'pending'").run(status, signature, id).changes > 0;
}
