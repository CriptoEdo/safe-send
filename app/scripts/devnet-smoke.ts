// Smoke test of the deployed program on Devnet: send with fee top-up to a brand-new wallet (0 SOL), the
// recipient verifies; then send and cancel. The sender is a funded keypair file (e.g. the deployer).
//   node scripts/devnet-smoke.ts <path/to/sender-keypair.json>
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import { claimPriorityCap, computeBudget } from '../src/lib/fees.ts';
import {
  ESCROW_SIZE, cancelSolIx, checkRecipientFees, decodeEscrow, claimSolIx, escrowAddress, newTransferId, sendSolIx, topUpIx, fetchConfig
} from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const config = await fetchConfig(connection); // the fee configuration (fees, treasury)
const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
// Like the app: compute budget measured by simulation, priority fee from recent fees (capped for claims)
async function run(signer: Keypair, ...ixs: TransactionInstruction[]) {
  const cap = ixs.some((ix) => ix.data.subarray(0, 8).equals(Buffer.from(claimSolIx({ recipient: signer.publicKey, sender: signer.publicKey, escrow: signer.publicKey }).data.subarray(0, 8))))
    ? await claimPriorityCap(connection, signer.publicKey) : undefined;
  const budget = await computeBudget(connection, ixs, signer.publicKey, cap);
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...budget.instructions, ...ixs), [signer], { commitment: 'confirmed' });
  const meta = (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.meta!;
  console.log(`  budget ${budget.units} CU (used ${meta.computeUnitsConsumed}) × ${budget.microLamports} µlamports, fee ${meta.fee} lamports${cap !== undefined ? `, claim cap ${cap}` : ''}`);
  return signature;
}
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const recipient = Keypair.generate();
const check = await checkRecipientFees(connection, recipient.publicKey);
console.log(`recipient ${recipient.publicKey.toBase58()} has ${check.balance} lamports, top-up ${check.topUp}`);

const id = newTransferId();
const amount = BigInt(0.01 * LAMPORTS_PER_SOL);
const sent = await run(sender, topUpIx(sender.publicKey, recipient.publicKey, check.topUp),
  sendSolIx({ config, sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: amount }));
console.log('sent + top-up:', tx(sent));
const escrowInfo = (await connection.getAccountInfo(escrowAddress(sender.publicKey, id)))!;
const layout = decodeEscrow(escrowAddress(sender.publicKey, id), escrowInfo);
if (escrowInfo.data.length !== ESCROW_SIZE || layout?.version !== 1) throw new Error(`unexpected escrow layout: ${escrowInfo.data.length} bytes, version ${layout?.version}`);
console.log(`escrow layout: ${escrowInfo.data.length} bytes, version ${layout.version}`);

const claimed = await run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
console.log('verified by the recipient:', tx(claimed), `→ recipient now ${await connection.getBalance(recipient.publicKey)} lamports`);

const id2 = newTransferId();
const sent2 = await run(sender, sendSolIx({ config, sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: id2, lamports: amount }));
const cancelled = await run(sender, cancelSolIx({ sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id2) }));
console.log('sent to a wrong address:', tx(sent2));
console.log('cancelled and refunded:', tx(cancelled));
