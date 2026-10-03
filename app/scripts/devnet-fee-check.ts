// Reproduces the "recipient cannot pay the claim fee" case on Devnet: the recipient holds only the old top-up
// (rent-exempt minimum + 20,000 lamports). A claim with a wallet-sized priority fee (~80,000 lamports, like
// Phantom adds) must fail; the same claim with the app's compute budget (claimFeeIxs) must succeed.
//   node scripts/devnet-fee-check.ts <path/to/sender-keypair.json>
import { readFileSync } from 'node:fs';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { claimFeeIxs, claimSolIx, escrowAddress, newTransferId, sendSolIx, topUpIx } from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
const send = (signer: Keypair, ...ixs: Parameters<Transaction['add']>) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: 'confirmed' });

const recipient = Keypair.generate();
const oldTopUp = (await connection.getMinimumBalanceForRentExemption(0)) + 20_000;
const id = newTransferId();
await send(sender, topUpIx(sender.publicKey, recipient.publicKey, oldTopUp),
  sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: BigInt(0.01 * LAMPORTS_PER_SOL) }));
console.log(`recipient funded with the old top-up: ${oldTopUp} lamports`);
const claim = claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) });

// 75,000 lamports of priority fee: 200,000 CU × 375,000 micro-lamports
const walletLike = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 375_000 })];
try {
  await send(recipient, ...walletLike, claim);
  console.log('wallet-sized priority fee: UNEXPECTEDLY succeeded');
} catch (err) {
  console.log('wallet-sized priority fee: fails as in the screenshot →', String((err as Error).message).split('\n')[0].slice(0, 120));
}
const sig = await send(recipient, ...claimFeeIxs(), claim);
console.log(`app compute budget: claimed ✓ https://explorer.solana.com/tx/${sig}?cluster=devnet`);
console.log(`recipient now ${await connection.getBalance(recipient.publicKey)} lamports`);
