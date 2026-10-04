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

// Wallets used with Safe Send in this browser (the "Switch wallet" list). Empty means disconnected: the first
// connection asks for a signature, then Safe Send follows the account selected in Phantom until "Disconnect".
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

// Wallets disconnected one by one: Phantom keeps trusting them (it can only revoke the site for all accounts at
// once), so Safe Send ignores them until they are connected again with a signature.
const DISCONNECTED_KEY = 'safe-send:disconnected';

function disconnectedWallets(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(DISCONNECTED_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveDisconnected(list: string[]): void {
  try { localStorage.setItem(DISCONNECTED_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export const isDisconnected = (wallet: string) => disconnectedWallets().includes(wallet);

export function rememberWallet(wallet: string): void {
  if (!connectedWallets().includes(wallet)) saveWallets([...connectedWallets(), wallet]);
  if (isDisconnected(wallet)) saveDisconnected(disconnectedWallets().filter((w) => w !== wallet));
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
    rememberWallet(wallet.toBase58());
    return wallet;
  } catch {
    if (connectedWallets().length === 0) await provider.disconnect().catch(() => {});
    return null;
  }
}

// Phantom's approval popup for the selected account (no message to sign): used when the user switches to an
// account that has not approved Safe Send yet. Returns the account, or null if refused.
export async function approveAccount(): Promise<PublicKey | null> {
  const provider = phantom();
  if (!provider) return null;
  try {
    const { publicKey } = await provider.connect();
    const wallet = new PublicKey(publicKey.toString());
    rememberWallet(wallet.toBase58());
    return wallet;
  } catch {
    return null;
  }
}

// Disconnects one wallet; the other connected wallets stay. Disconnecting the last one also revokes the site
// in Phantom. The list is updated before the first await, so callers can render right away.
export async function disconnectWallet(wallet: string): Promise<void> {
  const remaining = connectedWallets().filter((w) => w !== wallet);
  saveWallets(remaining);
  if (remaining.length > 0) {
    saveDisconnected([...disconnectedWallets().filter((w) => w !== wallet), wallet]);
    return;
  }
  saveDisconnected([]);
  await phantom()?.disconnect().catch(() => {});
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
