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
  const current = readGenesis();
  if (current === undefined || current === GENESIS_HASH) return;
  if (!provider.changeNetwork) throw new Error(NETWORK_HELP);
  await provider.changeNetwork({ genesisHash: GENESIS_HASH, url: RPC_URL }).catch(() => undefined);
  // The switch is confirmed in a Nightly popup; give the user time to approve it.
  for (let i = 0; i < 40 && readGenesis() !== GENESIS_HASH; i++) await new Promise((r) => setTimeout(r, 500));
  if (readGenesis() !== GENESIS_HASH) throw new Error(NETWORK_HELP);
}

export const NETWORK_HELP =
  "Nightly is still on Solana. Approve the network switch in the Nightly popup, or in Nightly open the network menu → Custom SVM network → RPC https://rpc.cookiescan.io, then try again.";

export async function connectNightly(): Promise<PublicKey> {
  provider = await findNightly();
  if (!provider) throw new Error("Nightly not found. Install the Nightly extension from nightly.app and reload.");
  const res = await provider.connect();
  const key = (res && "publicKey" in res && res.publicKey) || provider.publicKey;
  if (!key) throw new Error("Nightly did not return a public key.");
  // Nightly ignores a network change from a site it isn't connected to, so switch only after connect.
  // Declining here is not fatal: signing re-checks and asks again.
  await ensureCookieNetwork().catch(() => undefined);
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
  await ensureCookieNetwork();
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
