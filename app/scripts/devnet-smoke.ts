// Smoke test of the deployed program on Devnet: send with fee top-up to a brand-new wallet (0 SOL), the
// recipient verifies; then send and cancel. The sender is a funded keypair file (e.g. the deployer).
//   node scripts/devnet-smoke.ts <path/to/sender-keypair.json>
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ESCROW_SIZE, cancelSolIx, checkRecipientFees, decodeEscrow, claimSolIx, escrowAddress, newTransferId, sendSolIx, topUpIx,
} from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
const run = (signer: Keypair, ...ixs: Parameters<Transaction['add']>) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: 'confirmed' });
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const recipient = Keypair.generate();
const check = await checkRecipientFees(connection, recipient.publicKey);
console.log(`recipient ${recipient.publicKey.toBase58()} has ${check.balance} lamports, top-up ${check.topUp}`);

const id = newTransferId();
const amount = BigInt(0.01 * LAMPORTS_PER_SOL);
const sent = await run(sender, topUpIx(sender.publicKey, recipient.publicKey, check.topUp),
  sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: amount }));
console.log('sent + top-up:', tx(sent));
const escrowInfo = (await connection.getAccountInfo(escrowAddress(sender.publicKey, id)))!;
const layout = decodeEscrow(escrowAddress(sender.publicKey, id), escrowInfo);
if (escrowInfo.data.length !== ESCROW_SIZE || layout?.version !== 1) throw new Error(`unexpected escrow layout: ${escrowInfo.data.length} bytes, version ${layout?.version}`);
console.log(`escrow layout: ${escrowInfo.data.length} bytes, version ${layout.version}`);

const claimed = await run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
console.log('verified by the recipient:', tx(claimed), `→ recipient now ${await connection.getBalance(recipient.publicKey)} lamports`);

const id2 = newTransferId();
const sent2 = await run(sender, sendSolIx({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: id2, lamports: amount }));
const cancelled = await run(sender, cancelSolIx({ sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id2) }));
console.log('sent to a wrong address:', tx(sent2));
console.log('cancelled and refunded:', tx(cancelled));
