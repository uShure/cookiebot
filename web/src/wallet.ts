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

export async function connectNightly(): Promise<PublicKey> {
  provider = await findNightly();
  if (!provider) throw new Error("Nightly not found. Install the Nightly extension from nightly.app and reload.");
  // Ask Nightly to point at Cookie Chain; a user can decline and still sign (we broadcast ourselves).
  if (provider.changeNetwork) {
    await provider.changeNetwork({ genesisHash: GENESIS_HASH, url: RPC_URL }).catch(() => undefined);
  }
  const res = await provider.connect();
  const key = (res && "publicKey" in res && res.publicKey) || provider.publicKey;
  if (!key) throw new Error("Nightly did not return a public key.");
  return new PublicKey(key.toString());
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
  onStage("signing");
  let signature: string;
  if (provider.signTransaction) {
    const signed = await provider.signTransaction(tx);
    onStage("sending");
    signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  } else if (provider.signAndSendTransaction) {
    const sent = await provider.signAndSendTransaction(tx);
    signature = typeof sent === "string" ? sent : sent.signature;
  } else {
    throw new Error("This wallet cannot sign transactions.");
  }
  onStage("confirming");
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
  return signature;
}
