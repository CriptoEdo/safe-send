import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type Connection, type AccountInfo,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getExtensionTypes,
  getAccountLen, getAccountLenForMint, getAccountTypeOfMintType, getTransferFeeConfig, getTransferHook, unpackMint,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';

// Client for the Safe Send program (programs/safe_send/src/lib.rs): instruction builders, account decoding
// and the recipient fee check. Written by hand (Anchor's discriminators and Borsh layout), so it needs no IDL.

export const PROGRAM_ID = new PublicKey('EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg');
// Pubkey::default(): the escrow's mint when it holds SOL.
export const SOL_MINT = new PublicKey(new Uint8Array(32));

const encoder = new TextEncoder();
const discriminator = (name: string) => sha256(encoder.encode(name)).slice(0, 8);
const IX = {
  sendSol: discriminator('global:send_sol'),
  claimSol: discriminator('global:claim_sol'),
  cancelSol: discriminator('global:cancel_sol'),
  sendToken: discriminator('global:send_token'),
  claimToken: discriminator('global:claim_token'),
  cancelToken: discriminator('global:cancel_token'),
  initializeConfig: discriminator('global:initialize_config'),
  updateConfig: discriminator('global:update_config'),
};
const ESCROW_DISCRIMINATOR = discriminator('account:Escrow');
const CONFIG_DISCRIMINATOR = discriminator('account:Config');

const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

const data = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return Buffer.from(out);
};

// A fresh id per transfer: the escrow address is derived from (sender, id).
export const newTransferId = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

export function escrowAddress(sender: PublicKey, id: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([encoder.encode('escrow'), sender.toBytes(), u64(id)], PROGRAM_ID)[0];
}

export function vaultAddress(escrow: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([encoder.encode('vault'), escrow.toBytes()], PROGRAM_ID)[0];
}

// --- Fee configuration ---

export const CONFIG_ADDRESS = PublicKey.findProgramAddressSync([encoder.encode('config')], PROGRAM_ID)[0];
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const PROGRAM_DATA_ADDRESS = PublicKey.findProgramAddressSync([PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE)[0];
// Upper bounds fixed in the program (MAX_FEE_BPS, MAX_FLAT_FEE_LAMPORTS).
export const MAX_FEE_BPS = 100;
export const MAX_FLAT_FEE_LAMPORTS = 10_000_000n;

export interface FeeConfig {
  admin: PublicKey;
  treasury: PublicKey;
  feeBps: number; // basis points of the amount, paid in what is sent (30 = 0.3%)
  flatFeeLamports: bigint; // fixed SOL fee per send
}

export async function fetchConfig(connection: Connection): Promise<FeeConfig> {
  const account = await connection.getAccountInfo(CONFIG_ADDRESS);
  if (!account) throw new Error('Safe Send is not configured on this network (no Config account)');
  const bytes = account.data;
  if (!CONFIG_DISCRIMINATOR.every((b, i) => bytes[i] === b)) throw new Error('Not a Safe Send Config account');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    admin: new PublicKey(bytes.subarray(8, 40)),
    treasury: new PublicKey(bytes.subarray(40, 72)),
    feeBps: view.getUint16(72, true),
    flatFeeLamports: view.getBigUint64(74, true),
  };
}

// The percentage fee on `amount`, rounded down like the program.
export const percentFee = (config: FeeConfig, amount: bigint) => (amount * BigInt(config.feeBps)) / 10_000n;

const u16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const ix = (keys: TransactionInstruction['keys'], bytes: Buffer) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data: bytes });

// Creates the Config with no fees; only the program's upgrade authority can sign it.
export function initializeConfigIx(p: { authority: PublicKey; treasury: PublicKey }) {
  return ix([w(p.authority, true), w(CONFIG_ADDRESS), r(PROGRAM_DATA_ADDRESS), r(SystemProgram.programId)],
    data(IX.initializeConfig, p.treasury.toBytes()));
}

export function updateConfigIx(p: { admin: PublicKey; config: FeeConfig }) {
  return ix([{ pubkey: p.admin, isSigner: true, isWritable: false }, w(CONFIG_ADDRESS)], data(
    IX.updateConfig, p.config.admin.toBytes(), p.config.treasury.toBytes(), u16(p.config.feeBps), u64(p.config.flatFeeLamports)));
}

// --- SOL ---

export function sendSolIx(p: { sender: PublicKey; recipient: PublicKey; id: bigint; lamports: bigint; config: FeeConfig }) {
  const escrow = escrowAddress(p.sender, p.id);
  return ix([w(p.sender, true), r(p.recipient), r(CONFIG_ADDRESS), w(p.config.treasury), w(escrow), r(SystemProgram.programId)],
    data(IX.sendSol, u64(p.id), u64(p.lamports)));
}

export function claimSolIx(p: { recipient: PublicKey; sender: PublicKey; escrow: PublicKey }) {
  return ix([w(p.recipient, true), w(p.sender), w(p.escrow)], data(IX.claimSol));
}

export function cancelSolIx(p: { sender: PublicKey; escrow: PublicKey }) {
  return ix([w(p.sender, true), w(p.escrow)], data(IX.cancelSol));
}

// --- Tokens (SPL Token and Token-2022) ---

// What the client needs to know about a mint: its token program, decimals and the Token-2022 extensions that
// change how a transfer behaves.
export interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey; // TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
  decimals: number;
  // Transfer fee in basis points and its cap (base units), if the token charges one on every transfer.
  transferFee: { basisPoints: number; maximum: bigint } | null;
  // Refused by the program: a hook program could block the release of an escrow.
  transferHook: boolean;
  // The issuer can move tokens out of any account, including the escrow.
  permanentDelegate: boolean;
  // Sizes (bytes) of a token account for this mint: the vault, and an associated token account (Token-2022 adds
  // the immutable-owner extension to those). They set the deposits the sender pays.
  vaultSize: number;
  ataSize: number;
}

export async function mintInfos(connection: Connection, mints: PublicKey[]): Promise<Map<string, MintInfo>> {
  const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
  const out = new Map<string, MintInfo>();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const accounts = await connection.getMultipleAccountsInfo(batch);
    batch.forEach((mint, j) => {
      const account = accounts[j];
      if (!account) throw new Error(`Mint ${mint.toBase58()} not found`);
      const tokenProgram = account.owner;
      const state = unpackMint(mint, account, tokenProgram);
      const extensions = tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? getExtensionTypes(state.tlvData) : [];
      const fee = getTransferFeeConfig(state);
      const hook = getTransferHook(state);
      // The newer fee applies from its epoch on; the higher of the two is the safe one to show.
      const feeConfig = fee && (fee.newerTransferFee.transferFeeBasisPoints >= fee.olderTransferFee.transferFeeBasisPoints
        ? fee.newerTransferFee : fee.olderTransferFee);
      out.set(mint.toBase58(), {
        mint,
        tokenProgram,
        decimals: state.decimals,
        transferFee: feeConfig && (feeConfig.transferFeeBasisPoints > 0)
          ? { basisPoints: feeConfig.transferFeeBasisPoints, maximum: feeConfig.maximumFee } : null,
        transferHook: !!hook && (!hook.programId.equals(PublicKey.default) || !hook.authority.equals(PublicKey.default)),
        permanentDelegate: extensions.includes(ExtensionType.PermanentDelegate),
        vaultSize: getAccountLenForMint(state),
        ataSize: tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
          ? getAccountLen([...extensions.map(getAccountTypeOfMintType).filter((e) => e !== ExtensionType.Uninitialized), ExtensionType.ImmutableOwner])
          : getAccountLenForMint(state),
      });
    });
  }
  return out;
}

// The fee a token with a transfer fee withholds from one transfer of `amount` (Token-2022 rounds up).
export function transferFeeOf(info: MintInfo, amount: bigint): bigint {
  if (!info.transferFee) return 0n;
  const fee = (amount * BigInt(info.transferFee.basisPoints) + 9_999n) / 10_000n;
  return fee > info.transferFee.maximum ? info.transferFee.maximum : fee;
}

const tokenAccount = (mint: MintInfo, owner: PublicKey) => getAssociatedTokenAddressSync(mint.mint, owner, true, mint.tokenProgram);
// The mint is written only when withheld transfer fees are harvested to it on release.
const releaseMint = (mint: MintInfo) => (mint.transferFee ? w(mint.mint) : r(mint.mint));

// Create the recipient's token account if missing (paid by the sender, so verifying only costs the recipient
// the fee) and, with a percentage fee, the treasury's; then lock the tokens.
export function sendTokenIxs(p: { sender: PublicKey; recipient: PublicKey; mint: MintInfo; senderToken: PublicKey; id: bigint; amount: bigint; config: FeeConfig }) {
  const escrow = escrowAddress(p.sender, p.id);
  const treasuryToken = percentFee(p.config, p.amount) > 0n ? tokenAccount(p.mint, p.config.treasury) : null;
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      p.sender, tokenAccount(p.mint, p.recipient), p.recipient, p.mint.mint, p.mint.tokenProgram),
    ...(treasuryToken ? [createAssociatedTokenAccountIdempotentInstruction(
      p.sender, treasuryToken, p.config.treasury, p.mint.mint, p.mint.tokenProgram)] : []),
    ix([
      w(p.sender, true), r(p.recipient), r(p.mint.mint), w(p.senderToken),
      r(CONFIG_ADDRESS), w(p.config.treasury), treasuryToken ? w(treasuryToken) : r(PROGRAM_ID), // PROGRAM_ID = none
      w(escrow), w(vaultAddress(escrow)), r(p.mint.tokenProgram), r(SystemProgram.programId),
    ], data(IX.sendToken, u64(p.id), u64(p.amount))),
  ];
}

export function claimTokenIx(p: { recipient: PublicKey; sender: PublicKey; mint: MintInfo; escrow: PublicKey }) {
  return ix([
    w(p.recipient, true), w(p.sender), releaseMint(p.mint), w(tokenAccount(p.mint, p.recipient)),
    w(p.escrow), w(vaultAddress(p.escrow)),
    r(p.mint.tokenProgram), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
  ], data(IX.claimToken));
}

export function cancelTokenIx(p: { sender: PublicKey; mint: MintInfo; escrow: PublicKey }) {
  return ix([
    w(p.sender, true), releaseMint(p.mint), w(tokenAccount(p.mint, p.sender)),
    w(p.escrow), w(vaultAddress(p.escrow)),
    r(p.mint.tokenProgram), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
  ], data(IX.cancelToken));
}

// --- Reading transfers ---

export interface PendingTransfer {
  address: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  mint: PublicKey; // SOL_MINT for SOL
  isSol: boolean;
  amount: bigint; // lamports or token base units
  id: bigint;
  createdAt: number; // ms
  version: number; // escrow layout version
}

// Escrow layout: discriminator (8) + sender (32) + recipient (32) + mint (32) + amount, id, created_at (8 each)
// + bump (1) + version (1) + reserved (64, zero: room for future fields without changing the size).
const SENDER_OFFSET = 8;
const RECIPIENT_OFFSET = 40;
const VERSION_OFFSET = 129;
export const ESCROW_RESERVED = 64;
export const ESCROW_SIZE = 8 + 32 * 3 + 8 * 3 + 1 + 1 + ESCROW_RESERVED;

export function decodeEscrow(address: PublicKey, account: Pick<AccountInfo<Buffer>, 'data'>): PendingTransfer | null {
  const bytes = account.data;
  if (bytes.length !== ESCROW_SIZE || !ESCROW_DISCRIMINATOR.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mint = new PublicKey(bytes.subarray(72, 104));
  return {
    address,
    sender: new PublicKey(bytes.subarray(SENDER_OFFSET, SENDER_OFFSET + 32)),
    recipient: new PublicKey(bytes.subarray(RECIPIENT_OFFSET, RECIPIENT_OFFSET + 32)),
    mint,
    isSol: mint.equals(SOL_MINT),
    amount: view.getBigUint64(104, true),
    id: view.getBigUint64(112, true),
    createdAt: Number(view.getBigInt64(120, true)) * 1000,
    version: bytes[VERSION_OFFSET],
  };
}

async function transfersBy(connection: Connection, offset: number, wallet: PublicKey): Promise<PendingTransfer[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: ESCROW_SIZE }, { memcmp: { offset, bytes: wallet.toBase58() } }],
  });
  return accounts
    .map((a) => decodeEscrow(a.pubkey, a.account))
    .filter((t): t is PendingTransfer => t !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Transfers waiting for this wallet to verify them.
export const incomingTransfers = (connection: Connection, wallet: PublicKey) => transfersBy(connection, RECIPIENT_OFFSET, wallet);
// Transfers this wallet sent that are not verified yet (it can still cancel them).
export const outgoingTransfers = (connection: Connection, wallet: PublicKey) => transfersBy(connection, SENDER_OFFSET, wallet);

// --- Events ---

// The program's events (Anchor `emit!`), read from a transaction's logs ("Program data: <base64>").
export type SafeSendEvent =
  | { name: 'TransferSent'; escrow: PublicKey; sender: PublicKey; recipient: PublicKey; mint: PublicKey; amount: bigint; fee: bigint; flatFeeLamports: bigint }
  | { name: 'TransferClaimed' | 'TransferCancelled'; escrow: PublicKey; sender: PublicKey; recipient: PublicKey; mint: PublicKey; amount: bigint }
  | { name: 'ConfigUpdated'; admin: PublicKey; treasury: PublicKey; feeBps: number; flatFeeLamports: bigint };

const EVENTS = ['TransferSent', 'TransferClaimed', 'TransferCancelled', 'ConfigUpdated'] as const;
const EVENT_DISCRIMINATORS = EVENTS.map((name) => ({ name, bytes: discriminator(`event:${name}`) }));

export function parseEvents(logs: string[]): SafeSendEvent[] {
  const events: SafeSendEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const bytes = Buffer.from(line.slice('Program data: '.length), 'base64');
    const kind = EVENT_DISCRIMINATORS.find((e) => e.bytes.every((b, i) => bytes[i] === b));
    if (!kind) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const key = (offset: number) => new PublicKey(bytes.subarray(offset, offset + 32));
    const u64at = (offset: number) => view.getBigUint64(offset, true);
    if (kind.name === 'ConfigUpdated') {
      events.push({ name: kind.name, admin: key(8), treasury: key(40), feeBps: view.getUint16(72, true), flatFeeLamports: u64at(74) });
    } else {
      const base = { escrow: key(8), sender: key(40), recipient: key(72), mint: key(104), amount: u64at(136) };
      events.push(kind.name === 'TransferSent'
        ? { name: kind.name, ...base, fee: u64at(144), flatFeeLamports: u64at(152) }
        : { name: kind.name, ...base });
    }
  }
  return events;
}

// --- Recipient fee check ---

// Lamports the recipient needs to verify, on top of the minimum balance a Solana account must keep
// (rent-exempt minimum): the fee payer has to stay above that minimum *after* paying the fee, before the claim
// even runs. It covers the signature fee plus the claim's priority fee, which the app keeps within
// MAX_CLAIM_PRIORITY_LAMPORTS (fees.ts) however busy the network is.
export const CLAIM_FEE_LAMPORTS = 100_000;

// A fixed, small compute budget (100,000 CU × 1,000 micro-lamports = 100 lamports + 5,000 base), for scripts
// and tests. The app computes the budget per transaction instead (fees.ts). Either way the transaction sets
// one: wallets like Phantom add their own priority fee only when it does not (0.00008 SOL seen on Devnet).
export const claimFeeIxs = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
];

export interface FeeCheck {
  balance: number; // recipient's lamports now
  required: number; // lamports they need to be able to verify
  topUp: number; // lamports the sender adds to the transfer (0 if the recipient can already pay)
}

export async function checkRecipientFees(connection: Connection, recipient: PublicKey): Promise<FeeCheck> {
  const [balance, rentExempt] = await Promise.all([
    connection.getBalance(recipient),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  const required = rentExempt + CLAIM_FEE_LAMPORTS;
  return { balance, required, topUp: balance >= required ? 0 : required - balance };
}

// The top-up travels with the transfer, in the same transaction: a plain SOL transfer to the recipient.
export const topUpIx = (sender: PublicKey, recipient: PublicKey, lamports: number) =>
  SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports });
