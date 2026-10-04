import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type Connection, type AccountInfo,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
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
};
const ESCROW_DISCRIMINATOR = discriminator('account:Escrow');

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

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const ix = (keys: TransactionInstruction['keys'], bytes: Buffer) => new TransactionInstruction({ programId: PROGRAM_ID, keys, data: bytes });

// --- SOL ---

export function sendSolIx(p: { sender: PublicKey; recipient: PublicKey; id: bigint; lamports: bigint }) {
  const escrow = escrowAddress(p.sender, p.id);
  return ix([w(p.sender, true), r(p.recipient), w(escrow), r(SystemProgram.programId)], data(IX.sendSol, u64(p.id), u64(p.lamports)));
}

export function claimSolIx(p: { recipient: PublicKey; sender: PublicKey; escrow: PublicKey }) {
  return ix([w(p.recipient, true), w(p.sender), w(p.escrow)], data(IX.claimSol));
}

export function cancelSolIx(p: { sender: PublicKey; escrow: PublicKey }) {
  return ix([w(p.sender, true), w(p.escrow)], data(IX.cancelSol));
}

// --- SPL tokens ---

// Two instructions: create the recipient's token account if missing (paid by the sender, so verifying only
// costs the recipient the fee), then lock the tokens.
export function sendTokenIxs(p: { sender: PublicKey; recipient: PublicKey; mint: PublicKey; senderToken: PublicKey; id: bigint; amount: bigint }) {
  const escrow = escrowAddress(p.sender, p.id);
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.sender, getAssociatedTokenAddressSync(p.mint, p.recipient, true), p.recipient, p.mint),
    ix([
      w(p.sender, true), r(p.recipient), r(p.mint), w(p.senderToken), w(escrow), w(vaultAddress(escrow)),
      r(TOKEN_PROGRAM_ID), r(SystemProgram.programId),
    ], data(IX.sendToken, u64(p.id), u64(p.amount))),
  ];
}

export function claimTokenIx(p: { recipient: PublicKey; sender: PublicKey; mint: PublicKey; escrow: PublicKey }) {
  return ix([
    w(p.recipient, true), w(p.sender), r(p.mint), w(getAssociatedTokenAddressSync(p.mint, p.recipient, true)),
    w(p.escrow), w(vaultAddress(p.escrow)),
    r(TOKEN_PROGRAM_ID), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
  ], data(IX.claimToken));
}

export function cancelTokenIx(p: { sender: PublicKey; mint: PublicKey; escrow: PublicKey }) {
  return ix([
    w(p.sender, true), r(p.mint), w(getAssociatedTokenAddressSync(p.mint, p.sender, true)),
    w(p.escrow), w(vaultAddress(p.escrow)),
    r(TOKEN_PROGRAM_ID), r(ASSOCIATED_TOKEN_PROGRAM_ID), r(SystemProgram.programId),
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

// --- Recipient fee check ---

// Lamports the recipient needs to verify, on top of the minimum balance a Solana account must keep
// (rent-exempt minimum): the fee payer has to stay above that minimum *after* paying the fee, before the claim
// even runs. The claim sets its own small priority fee (claimFeeIxs), so it costs ~5,100 lamports; the rest
// is margin.
export const CLAIM_FEE_LAMPORTS = 100_000;

// Compute budget for claim and cancel transactions. Wallets like Phantom add their own priority fee when a
// transaction sets none (0.00008 SOL seen on Devnet), which a recipient funded only with the top-up cannot
// pay. Setting it here keeps the fee predictable: 100,000 CU × 1,000 micro-lamports = 100 lamports + 5,000 base.
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
