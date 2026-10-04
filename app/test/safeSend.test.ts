// End-to-end tests of the Safe Send program on a local validator with the program loaded:
//   (WSL) solana-test-validator --reset --bpf-program EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg target/deploy/safe_send.so
//   npm test                      (or TEST_RPC=<url> npm test)
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import {
  CLAIM_FEE_LAMPORTS, ESCROW_RESERVED, ESCROW_SIZE, cancelSolIx, claimFeeIxs, cancelTokenIx, checkRecipientFees, claimSolIx, claimTokenIx, escrowAddress,
  incomingTransfers, newTransferId, outgoingTransfers, sendSolIx, sendTokenIxs, topUpIx, vaultAddress,
} from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.TEST_RPC ?? 'http://127.0.0.1:8899', 'confirmed');

async function funded(sol = 10): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
  return kp;
}

const run = (signer: Keypair, ...ixs: Parameters<Transaction['add']>) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: 'confirmed' });

// The program's error message, from the simulation logs of a failed transaction.
async function rejects(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, (err: Error & { logs?: string[] }) => {
    const text = `${err.message}\n${(err.logs ?? []).join('\n')}`;
    assert.match(text, message);
    return true;
  });
}

const balance = (k: PublicKey) => connection.getBalance(k);

// The fee a transaction actually paid. A freshly started validator charges 0 per signature for its first
// blocks, so tests read the fee instead of assuming 5,000 lamports.
async function feeOf(signature: string): Promise<number> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return tx!.meta!.fee;
}

let sender: Keypair;
before(async () => {
  sender = await funded(20);
});

test('SOL: locked until the recipient verifies, then the recipient gets the amount and the sender the rent', async () => {
  const recipient = await funded(1);
  const id = newTransferId();
  const amount = 2n * BigInt(LAMPORTS_PER_SOL);
  await run(sender, sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: amount }));
  const escrow = escrowAddress(sender.publicKey, id);
  assert.ok((await balance(escrow)) > Number(amount));

  const [incoming] = await incomingTransfers(connection, recipient.publicKey);
  assert.equal(incoming.amount, amount);
  assert.ok(incoming.isSol);
  assert.ok(incoming.sender.equals(sender.publicKey));
  assert.equal((await outgoingTransfers(connection, sender.publicKey)).filter((t) => t.address.equals(escrow)).length, 1);

  // Someone else cannot verify it
  const stranger = await funded(1);
  await rejects(run(stranger, claimSolIx({ recipient: stranger.publicKey, sender: sender.publicKey, escrow })), /Only the recipient can verify/);

  const recipientBefore = await balance(recipient.publicKey);
  const senderBefore = await balance(sender.publicKey);
  const claim = await run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow }));
  // Recipient: + amount - fee. Sender: + escrow rent back.
  assert.equal(await balance(recipient.publicKey), recipientBefore + Number(amount) - await feeOf(claim));
  assert.ok((await balance(sender.publicKey)) > senderBefore);
  assert.equal(await connection.getAccountInfo(escrow), null);
  // Verified once: nothing left to verify
  await rejects(run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow })), /AccountNotInitialized|not initialized|could not find/i);
});

test('SOL: a wrong address never verifies, and the sender cancels and gets everything back', async () => {
  const wrong = Keypair.generate().publicKey; // nobody we know holds this key
  const id = newTransferId();
  const amount = BigInt(LAMPORTS_PER_SOL);
  const before = await balance(sender.publicKey);
  const send = await run(sender, sendSolIx({ sender: sender.publicKey, recipient: wrong, id, lamports: amount }));
  const escrow = escrowAddress(sender.publicKey, id);

  // Only the sender can cancel
  const other = await funded(1);
  await rejects(run(other, cancelSolIx({ sender: other.publicKey, escrow })), /ConstraintSeeds|Only the sender|seeds constraint/i);

  const cancel = await run(sender, cancelSolIx({ sender: sender.publicKey, escrow }));
  assert.equal(await connection.getAccountInfo(escrow), null);
  // Back to the starting balance, minus the two transaction fees
  assert.equal(await balance(sender.publicKey), before - await feeOf(send) - await feeOf(cancel));
});

test('the extreme case: a recipient with 0 SOL gets the fee from the sender, then verifies paying it themselves', async () => {
  const recipient = Keypair.generate(); // a brand-new wallet: 0 SOL
  const check = await checkRecipientFees(connection, recipient.publicKey);
  assert.equal(check.balance, 0);
  const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
  assert.equal(check.topUp, rentExempt + CLAIM_FEE_LAMPORTS);

  const id = newTransferId();
  const amount = BigInt(LAMPORTS_PER_SOL / 2);
  // Top-up and transfer in one transaction
  await run(sender,
    topUpIx(sender.publicKey, recipient.publicKey, check.topUp),
    sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: amount }));
  assert.equal(await balance(recipient.publicKey), check.topUp);
  assert.equal((await checkRecipientFees(connection, recipient.publicKey)).topUp, 0);

  // The recipient pays its own fee to verify, with the app's compute budget: at most 5,000 + 100 lamports of priority
  const claim = await run(recipient, ...claimFeeIxs(), claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
  const fee = await feeOf(claim);
  assert.ok(fee <= 5100, `claim fee ${fee}`);
  assert.equal(await balance(recipient.publicKey), check.topUp + Number(amount) - fee);
});

test('without the top-up, a recipient with 0 SOL could not verify', async () => {
  const recipient = Keypair.generate();
  const id = newTransferId();
  await run(sender, sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: 1_000_000n }));
  const tx = new Transaction().add(claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
  await assert.rejects(sendAndConfirmTransaction(connection, tx, [recipient]), /insufficient|no record of a prior credit|AccountNotFound|debit an account/i);
  await run(sender, cancelSolIx({ sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
});

test('invalid transfers are refused: to yourself, or of zero', async () => {
  await rejects(run(sender, sendSolIx({ sender: sender.publicKey, recipient: sender.publicKey, id: newTransferId(), lamports: 1000n })), /cannot send to your own wallet/);
  await rejects(run(sender, sendSolIx({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: newTransferId(), lamports: 0n })), /greater than zero/);
});

test('SPL token: the recipient account is created by the sender, tokens wait in the vault, verify moves them', async () => {
  const mint = await createMint(connection, sender, sender.publicKey, null, 6);
  const senderToken = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);
  await mintTo(connection, sender, mint, senderToken.address, sender, 1_000_000_000n);

  const recipient = await funded(1);
  const id = newTransferId();
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint, senderToken: senderToken.address, id, amount: 250_000_000n }));
  const escrow = escrowAddress(sender.publicKey, id);
  const recipientToken = getAssociatedTokenAddressSync(mint, recipient.publicKey);
  assert.equal((await getAccount(connection, vaultAddress(escrow))).amount, 250_000_000n);
  assert.equal((await getAccount(connection, recipientToken)).amount, 0n); // created, still empty

  const [incoming] = await incomingTransfers(connection, recipient.publicKey);
  assert.ok(incoming.mint.equals(mint));
  assert.equal(incoming.isSol, false);

  await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint, escrow }));
  assert.equal((await getAccount(connection, recipientToken)).amount, 250_000_000n);
  assert.equal(await connection.getAccountInfo(vaultAddress(escrow)), null);
  assert.equal(await connection.getAccountInfo(escrow), null);

  // Cancel path: the tokens come back to the sender
  const id2 = newTransferId();
  const before = (await getAccount(connection, senderToken.address)).amount;
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint, senderToken: senderToken.address, id: id2, amount: 1_000_000n }));
  await run(sender, cancelTokenIx({ sender: sender.publicKey, mint, escrow: escrowAddress(sender.publicKey, id2) }));
  assert.equal((await getAccount(connection, senderToken.address)).amount, before);
});

test('a token transfer cannot be verified as SOL, nor by the wrong wallet', async () => {
  const mint = await createMint(connection, sender, sender.publicKey, null, 0);
  const senderToken = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);
  await mintTo(connection, sender, mint, senderToken.address, sender, 10n);
  const recipient = await funded(1);
  const id = newTransferId();
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint, senderToken: senderToken.address, id, amount: 5n }));
  const escrow = escrowAddress(sender.publicKey, id);
  await rejects(run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow })), /different asset/);
  const stranger = await funded(1);
  await rejects(run(stranger, claimTokenIx({ recipient: stranger.publicKey, sender: sender.publicKey, mint, escrow })), /Only the recipient can verify/);
  await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint, escrow }));
});


test('escrow layout: version 1 and zeroed reserved bytes, so future fields fit without resizing', async () => {
  const recipient = Keypair.generate();
  const id = newTransferId();
  await run(sender, sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: 1_000_000n }));
  const escrow = escrowAddress(sender.publicKey, id);
  const info = await connection.getAccountInfo(escrow);
  assert.equal(info!.data.length, ESCROW_SIZE);
  assert.equal(ESCROW_SIZE, 8 + 32 * 3 + 8 * 3 + 1 + 1 + ESCROW_RESERVED);
  const [t] = (await outgoingTransfers(connection, sender.publicKey)).filter((x) => x.address.equals(escrow));
  assert.equal(t.version, 1);
  assert.ok(info!.data.subarray(ESCROW_SIZE - ESCROW_RESERVED).every((b) => b === 0));
  await run(sender, cancelSolIx({ sender: sender.publicKey, escrow }));
});
