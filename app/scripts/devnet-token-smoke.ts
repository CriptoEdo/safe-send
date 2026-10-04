// Smoke test of token transfers on Devnet with a Token-2022 mint that charges a 1% transfer fee: send, the
// recipient claims (the withheld fee is harvested so the vault closes), then send and cancel. The sender is a
// funded keypair file (e.g. the deployer).
//   node scripts/devnet-token-smoke.ts <path/to/sender-keypair.json>
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  getAccount, getAssociatedTokenAddressSync, getMintLen, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import {
  cancelTokenIx, claimFeeIxs, claimTokenIx, escrowAddress, mintInfos, newTransferId, outgoingTransfers, sendTokenIxs, vaultAddress,
} from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
const run = (signers: Keypair[], ...ixs: Parameters<Transaction['add']>) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`✓ ${what}`); };

// A Token-2022 mint with a 1% transfer fee, 1,000 tokens (6 decimals) for the sender
const mintKey = Keypair.generate();
const space = getMintLen([ExtensionType.TransferFeeConfig]);
await run([sender, mintKey],
  SystemProgram.createAccount({
    fromPubkey: sender.publicKey, newAccountPubkey: mintKey.publicKey, space,
    lamports: await connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID,
  }),
  createInitializeTransferFeeConfigInstruction(mintKey.publicKey, sender.publicKey, sender.publicKey, 100, 10n ** 12n, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mintKey.publicKey, 6, sender.publicKey, null, TOKEN_2022_PROGRAM_ID));
const senderToken = (await getOrCreateAssociatedTokenAccount(connection, sender, mintKey.publicKey, sender.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address;
await mintTo(connection, sender, mintKey.publicKey, senderToken, sender, 1_000_000_000n, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
const mint = (await mintInfos(connection, [mintKey.publicKey])).get(mintKey.publicKey.toBase58())!;
console.log(`Token-2022 mint with 1% fee: ${mint.mint.toBase58()}`);

// Send 10 tokens to a new wallet, which claims them (funded by the sender with a little SOL for the fee)
const recipient = Keypair.generate();
await run([sender], SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: recipient.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }));
const id = newTransferId();
const escrow = escrowAddress(sender.publicKey, id);
console.log('sent:', tx(await run([sender], ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint, senderToken, id, amount: 10_000_000n }))));
check((await outgoingTransfers(connection, sender.publicKey)).find((t) => t.address.equals(escrow))?.amount === 9_900_000n, 'escrow records 9.9 (10 minus the 1% fee)');
console.log('claimed:', tx(await run([recipient], ...claimFeeIxs(), claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint, escrow }))));
const received = await getAccount(connection, getAssociatedTokenAddressSync(mint.mint, recipient.publicKey, true, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID);
check(received.amount === 9_801_000n, 'recipient received 9.801 (1% fee again on the way out)');
check(await connection.getAccountInfo(vaultAddress(escrow)) === null && await connection.getAccountInfo(escrow) === null, 'vault and escrow closed');

// Send to a wrong address and cancel
const id2 = newTransferId();
const escrow2 = escrowAddress(sender.publicKey, id2);
const before = (await getAccount(connection, senderToken, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
await run([sender], ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint, senderToken, id: id2, amount: 5_000_000n }));
console.log('cancelled:', tx(await run([sender], cancelTokenIx({ sender: sender.publicKey, mint, escrow: escrow2 }))));
const after = (await getAccount(connection, senderToken, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount;
check(before - after === 5_000_000n - 4_950_000n + 49_500n, 'cancel returned 4.9005 (two 1% fees)');
check(await connection.getAccountInfo(vaultAddress(escrow2)) === null && await connection.getAccountInfo(escrow2) === null, 'vault and escrow closed');
