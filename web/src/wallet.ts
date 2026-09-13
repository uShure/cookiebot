// Nightly wallet: connect, switch to Cookie Chain, sign. We always broadcast through the Cookie Chain
// RPC ourselves, so a wallet still pointed at Solana can't send the tx to the wrong network.
import { PublicKey, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";

import { GENESIS_HASH, RPC_URL } from "./api";

type AnyTx = Transaction | VersionedTransaction;

interface NightlySolana {
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  changeNetwork?(network: { genesisHash: string; url: string }): Promise<unknown>;
  signTransaction?<T extends AnyTx>(tx: T): Promise<T>;
  signAndSendTransaction?(tx: AnyTx): Promise<{ signature: string } | string>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    nightly?: { solana?: NightlySolana };
  }
}

let provider: NightlySolana | null = null;

/** The extension injects after page load; give it a moment before declaring it missing. */
export async function findNightly(timeoutMs = 1500): Promise<NightlySolana | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (window.nightly?.solana) return window.nightly.solana;
    await new Promise((r) => setTimeout(r, 100));
  }
  return window.nightly?.solana ?? null;
}

const readGenesis = (): string | undefined => {
  try {
    return (provider as { genesisHash?: string } | null)?.genesisHash;
  } catch {
    return undefined;
  }
};

/** True when Nightly reports Cookie Chain as its active network (unknown counts as not confirmed). */
export const onCookieChain = () => readGenesis() === GENESIS_HASH;

/**
 * Nightly simulates every transaction on its own active network before showing the approval.
 * Left on Solana, a COOK transfer fails there with "insufficient lamports", so switch first and
 * verify the switch actually happened.
 */
export async function ensureCookieNetwork(): Promise<void> {
  if (!provider) throw new Error("Connect Nightly first.");
  if (readGenesis() === GENESIS_HASH || !provider.changeNetwork) return;

  // Nightly can throw synchronously (e.g. "Not connected" after it dropped the site), so wrap the call.
  const request = async () => provider!.changeNetwork!({ genesisHash: GENESIS_HASH, url: RPC_URL });
  try {
    await request();
  } catch (e) {
    if (!/not connected/i.test(String((e as Error)?.message ?? e))) throw new NetworkSetupError();
    await provider.connect();
    try {
      await request();
    } catch {
      throw new NetworkSetupError();
    }
  }
  // The popup resolves the request; the reported network can lag a moment behind it.
  for (let i = 0; i < 6 && readGenesis() !== GENESIS_HASH; i++) await new Promise((r) => setTimeout(r, 500));
  const reported = readGenesis();
  // Only a network Nightly positively reports as different is an error; an empty value is "unknown".
  if (reported && reported !== GENESIS_HASH) throw new NetworkSetupError();
}

/** Nightly isn't on Cookie Chain, usually because the network was never added to it. */
export class NetworkSetupError extends Error {
  constructor() {
    super("Nightly is not on Cookie Chain yet. Add the network in Nightly, then try again.");
  }
}

export async function connectNightly(): Promise<{ key: PublicKey; networkReady: boolean }> {
  provider = await findNightly();
  if (!provider) throw new Error("Nightly not found. Install the Nightly extension from nightly.app and reload.");
  const res = await provider.connect();
  const key = (res && "publicKey" in res && res.publicKey) || provider.publicKey;
  if (!key) throw new Error("Nightly did not return a public key.");
  // Nightly ignores a network change from a site it isn't connected to, so switch only after connect.
  // Declining here is not fatal: signing re-checks and asks again.
  const networkReady = await ensureCookieNetwork().then(
    () => true,
    () => false,
  );
  return { key: new PublicKey(key.toString()), networkReady };
}

export function onAccountChange(cb: () => void): void {
  provider?.on?.("accountChanged", cb);
  provider?.on?.("disconnect", cb);
}

/** Sign in Nightly, broadcast via Cookie Chain RPC, confirm. Returns the signature. */
export async function signSendConfirm(
  connection: Connection,
  tx: AnyTx,
  blockhash: string,
  lastValidBlockHeight: number,
  onStage: (stage: "signing" | "sending" | "confirming") => void,
): Promise<string> {
  if (!provider) throw new Error("Connect Nightly first.");
  await ensureCookieNetwork();
  onStage("signing");
  let signature: string;
  let raw: Uint8Array | null = null;
  if (provider.signTransaction) {
    let signed: AnyTx;
    try {
      signed = await provider.signTransaction(tx);
    } catch (e) {
      // Nightly simulates on its own active network; a Solana balance error means it never switched.
      if (/insufficient lamports|InstructionError|simulation failed/i.test(String((e as Error)?.message ?? e))) {
        throw new NetworkSetupError();
      }
      throw e;
    }
    raw = signed.serialize();
    onStage("sending");
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  } else if (provider.signAndSendTransaction) {
    const sent = await provider.signAndSendTransaction(tx);
    signature = typeof sent === "string" ? sent : sent.signature;
  } else {
    throw new Error("This wallet cannot sign transactions.");
  }
  onStage("confirming");
  void blockhash;
  return confirmByPolling(connection, signature, raw, lastValidBlockHeight);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * web3.js confirmTransaction waits on a WebSocket subscription, and the public Cookie Chain WebSocket
 * drops those silently, leaving the UI stuck. Poll over HTTP instead, rebroadcasting the signed
 * transaction until it is confirmed or its blockhash expires.
 */
async function confirmByPolling(
  connection: Connection,
  signature: string,
  raw: Uint8Array | null,
  lastValidBlockHeight: number,
): Promise<string> {
  const started = Date.now();
  let lastResend = started;
  let lastHeightCheck = 0;
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature]).catch(() => null))?.value[0];
    if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;

    const now = Date.now();
    if (raw && now - lastResend >= 2000) {
      lastResend = now;
      connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    if (now - lastHeightCheck >= 4000) {
      lastHeightCheck = now;
      const height = await connection.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) {
        const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value[0];
        if (last && !last.err) return signature;
        throw new Error("The network didn’t pick up the transaction before it expired. Nothing was charged — try again.");
      }
    }
    if (now - started > 120_000) throw new Error("Still not confirmed after 2 minutes. Check Cookiescan before trying again.");
    await sleep(1000);
  }
}
