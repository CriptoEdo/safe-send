import { PublicKey, type Connection, type Transaction } from '@solana/web3.js';

// Phantom's injected provider (window.phantom.solana).
interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  on(event: 'accountChanged' | 'disconnect', handler: (key: PublicKey | null) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
  }
}

export const phantom = (): PhantomProvider | null => window.phantom?.solana?.isPhantom ? window.phantom.solana : null;

// Wallets the user connected in this browser, each with a signature. Phantom alone would reconnect any account
// it trusts as soon as it is selected; Safe Send only uses accounts on this list, and "Disconnect" removes one,
// so using it again needs a new signature.
const WALLETS_KEY = 'safe-send:wallets';

export function connectedWallets(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(WALLETS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveWallets(list: string[]): void {
  try { localStorage.setItem(WALLETS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

// The account currently selected in Phantom, without any popup (null if this site is not connected).
export async function selectedAccount(): Promise<PublicKey | null> {
  const provider = phantom();
  if (!provider) return null;
  try {
    const { publicKey } = await provider.connect({ onlyIfTrusted: true });
    return new PublicKey(publicKey.toString());
  } catch {
    return null;
  }
}

// Connects the account selected in Phantom and asks it to sign a short message: an explicit "yes, use this
// wallet here", even when Phantom already trusts the site. Returns the wallet, or null if refused.
export async function connectWithSignature(): Promise<PublicKey | null> {
  const provider = phantom();
  if (!provider) return null;
  try {
    const { publicKey } = await provider.connect();
    const wallet = new PublicKey(publicKey.toString());
    const message = [
      'Safe Send',
      '',
      `Connect wallet ${wallet.toBase58()} to Safe Send.`,
      `Nonce: ${crypto.getRandomValues(new Uint32Array(2)).join('')}`,
      `Issued: ${new Date().toISOString()}`,
      '',
      'Signing is free and moves no funds.',
    ].join('\n');
    await provider.signMessage(new TextEncoder().encode(message), 'utf8');
    saveWallets([...connectedWallets().filter((w) => w !== wallet.toBase58()), wallet.toBase58()]);
    return wallet;
  } catch {
    if (connectedWallets().length === 0) await provider.disconnect().catch(() => {});
    return null;
  }
}

// Removes a wallet from the connected list. The Phantom session is closed only when no wallet is left,
// so the other connected wallets keep working.
export async function disconnectWallet(wallet: PublicKey): Promise<void> {
  const list = connectedWallets().filter((w) => w !== wallet.toBase58());
  saveWallets(list);
  if (list.length === 0) await phantom()?.disconnect().catch(() => {});
}

// Signs with Phantom, sends, and waits for confirmation. Returns the signature.
export async function signAndSend(connection: Connection, tx: Transaction, feePayer: PublicKey): Promise<string> {
  const provider = phantom();
  if (!provider) throw new Error('Phantom not found');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  const signed = await provider.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}
