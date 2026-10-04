// A fake Phantom provider for browser tests: it behaves like Phantom (selected account, per-site trust,
// accountChanged with null for untrusted accounts) but signs with test keypairs kept in localStorage, so the
// app runs real transactions against a local validator. Never use it with real funds.
import '../../src/polyfills.ts';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

const load = <T>(key: string, fallback: T): T => JSON.parse(localStorage.getItem(`harness:${key}`) ?? 'null') ?? fallback;
const save = (key: string, value: unknown) => localStorage.setItem(`harness:${key}`, JSON.stringify(value));

const keys = (): Keypair[] => load<number[][]>('keys', []).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const selected = (): Keypair | null => keys()[load('selected', 0)] ?? null;
const trusted = () => new Set(load<string[]>('trusted', []));

const handlers: ((key: PublicKey | null) => void)[] = [];
const controls = { rejectNext: false, signDelayMs: 0, signs: 0, messages: 0 };

const provider = {
  isPhantom: true,
  get publicKey() {
    const k = selected();
    return k && trusted().has(k.publicKey.toBase58()) ? k.publicKey : null;
  },
  async connect(options?: { onlyIfTrusted?: boolean }) {
    const k = selected();
    if (!k) throw new Error('No account');
    const set = trusted();
    if (!set.has(k.publicKey.toBase58())) {
      if (options?.onlyIfTrusted) throw new Error('User rejected the request.');
      if (controls.rejectNext) { controls.rejectNext = false; throw new Error('User rejected the request.'); }
      save('trusted', [...set, k.publicKey.toBase58()]);
    }
    return { publicKey: k.publicKey };
  },
  async disconnect() { save('trusted', []); },
  async signMessage(_message: Uint8Array) {
    if (controls.rejectNext) { controls.rejectNext = false; throw new Error('User rejected the request.'); }
    controls.messages++;
    return { signature: new Uint8Array(64) };
  },
  async signTransaction(tx: Transaction) {
    const signer = selected()!; // the account shown in the approval popup, even if the user switches meanwhile
    if (!trusted().has(signer.publicKey.toBase58())) {
      throw Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100 });
    }
    await new Promise((r) => setTimeout(r, controls.signDelayMs));
    if (controls.rejectNext) { controls.rejectNext = false; throw new Error('User rejected the request.'); }
    controls.signs++;
    tx.partialSign(signer);
    return tx;
  },
  on(event: string, handler: (key: PublicKey | null) => void) {
    if (event === 'accountChanged') handlers.push(handler);
  },
};
(window as any).phantom = { solana: provider };

const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

(window as any).harness = {
  controls,
  connection,
  PublicKey,
  // Creates `count` funded test accounts (fresh state: wallets list, trust and selection are reset).
  async setup(count: number, sol = 2) {
    const list = Array.from({ length: count }, () => Keypair.generate());
    localStorage.clear();
    save('keys', list.map((k) => Array.from(k.secretKey)));
    save('selected', 0);
    await Promise.all(list.map(async (k) => {
      if (!sol) return;
      const sig = await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    }));
    return list.map((k) => k.publicKey.toBase58());
  },
  address: (i: number) => keys()[i].publicKey.toBase58(),
  // Selects account `i` in "Phantom", like clicking it in the extension.
  select(i: number) {
    save('selected', i);
    const k = keys()[i];
    const key = trusted().has(k.publicKey.toBase58()) ? k.publicKey : null;
    handlers.forEach((h) => h(key));
  },
  balance: (i: number) => connection.getBalance(keys()[i].publicKey),
  // A token mint with `amount` (whole tokens, 6 decimals) in account `i`.
  async mintTokens(i: number, amount: number) {
    const payer = keys()[i];
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    await mintTo(connection, payer, mint, ata.address, payer, BigInt(amount) * 1_000_000n);
    return mint.toBase58();
  },
  async tokenBalance(i: number, mint: string) {
    const res = await connection.getParsedTokenAccountsByOwner(keys()[i].publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmount), 0);
  },
  // An account with no SOL at all, to test the claim-fee top-up.
  async addEmptyAccount() {
    const k = Keypair.generate();
    save('keys', [...load<number[][]>('keys', []), Array.from(k.secretKey)]);
    return keys().length - 1;
  },
};
