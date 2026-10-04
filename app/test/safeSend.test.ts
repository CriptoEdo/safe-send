// End-to-end tests of the Safe Send program on a local validator with the program loaded:
//   (WSL) solana-test-validator --reset --bpf-program EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg target/deploy/safe_send.so
//   npm test                      (or TEST_RPC=<url> npm test)
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeDefaultAccountStateInstruction,
  createInitializeMintInstruction, createInitializeNonTransferableMintInstruction, createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction, createInitializeTransferHookInstruction, createMint, freezeAccount, getAccount,
  getAssociatedTokenAddressSync, getMint, getMintLen, getOrCreateAssociatedTokenAccount, getTransferFeeConfig, mintTo,
  thawAccount, transferChecked,
} from '@solana/spl-token';
import {
  CLAIM_FEE_LAMPORTS, ESCROW_RESERVED, ESCROW_SIZE, cancelSolIx, claimFeeIxs, cancelTokenIx, checkRecipientFees, claimSolIx, claimTokenIx, escrowAddress,
  incomingTransfers, mintInfos, newTransferId, outgoingTransfers, sendSolIx, sendTokenIxs, topUpIx, transferFeeOf, vaultAddress,
  type MintInfo,
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

// A mint of `tokenProgram` with `supply` tokens in the sender's token account. For Token-2022, `extensions`
// add their init instructions (they run before InitializeMint, as Token-2022 requires).
async function tokenWithBalance(p: {
  tokenProgram: PublicKey; decimals?: number; supply: bigint;
  extensions?: { types: ExtensionType[]; init: (mint: PublicKey) => ReturnType<typeof createInitializeMintInstruction>[] };
  freezeAuthority?: PublicKey;
}): Promise<{ info: MintInfo; senderToken: PublicKey }> {
  const decimals = p.decimals ?? 6;
  let mint: PublicKey;
  if (p.extensions) {
    const kp = Keypair.generate();
    mint = kp.publicKey;
    const space = getMintLen(p.extensions.types);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: sender.publicKey, newAccountPubkey: mint, space,
        lamports: await connection.getMinimumBalanceForRentExemption(space), programId: p.tokenProgram,
      }),
      ...p.extensions.init(mint),
      createInitializeMintInstruction(mint, decimals, sender.publicKey, p.freezeAuthority ?? null, p.tokenProgram),
    ), [sender, kp], { commitment: 'confirmed' });
  } else {
    mint = await createMint(connection, sender, sender.publicKey, p.freezeAuthority ?? null, decimals, undefined, { commitment: 'confirmed' }, p.tokenProgram);
  }
  const senderToken = (await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey, false, 'confirmed', undefined, p.tokenProgram)).address;
  if (p.extensions?.types.includes(ExtensionType.DefaultAccountState)) {
    await thawAccount(connection, sender, senderToken, mint, sender, [], { commitment: 'confirmed' }, p.tokenProgram);
  }
  await mintTo(connection, sender, mint, senderToken, sender, p.supply, [], { commitment: 'confirmed' }, p.tokenProgram);
  const info = (await mintInfos(connection, [mint])).get(mint.toBase58())!;
  return { info, senderToken };
}

const tokenBalance = async (info: MintInfo, account: PublicKey) => (await getAccount(connection, account, 'confirmed', info.tokenProgram)).amount;
const ata = (info: MintInfo, owner: PublicKey) => getAssociatedTokenAddressSync(info.mint, owner, true, info.tokenProgram);
const escrowOf = async (escrow: PublicKey) => (await outgoingTransfers(connection, sender.publicKey)).find((t) => t.address.equals(escrow));

for (const [name, tokenProgram] of [['SPL Token', TOKEN_PROGRAM_ID], ['Token-2022', TOKEN_2022_PROGRAM_ID]] as const) {
  test(`${name}: the recipient account is created by the sender, tokens wait in the vault, verify moves them`, async () => {
    const { info, senderToken } = await tokenWithBalance({ tokenProgram, supply: 1_000_000_000n });
    assert.ok(info.tokenProgram.equals(tokenProgram));

    const recipient = await funded(1);
    const id = newTransferId();
    await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 250_000_000n }));
    const escrow = escrowAddress(sender.publicKey, id);
    assert.equal(await tokenBalance(info, vaultAddress(escrow)), 250_000_000n);
    assert.equal(await tokenBalance(info, ata(info, recipient.publicKey)), 0n); // created, still empty
    assert.equal((await escrowOf(escrow))!.amount, 250_000_000n);

    const [incoming] = await incomingTransfers(connection, recipient.publicKey);
    assert.ok(incoming.mint.equals(info.mint));
    assert.equal(incoming.isSol, false);

    await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow }));
    assert.equal(await tokenBalance(info, ata(info, recipient.publicKey)), 250_000_000n);
    assert.equal(await connection.getAccountInfo(vaultAddress(escrow)), null);
    assert.equal(await connection.getAccountInfo(escrow), null);

    // Cancel path: the tokens come back to the sender
    const id2 = newTransferId();
    const before = await tokenBalance(info, senderToken);
    await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint: info, senderToken, id: id2, amount: 1_000_000n }));
    await run(sender, cancelTokenIx({ sender: sender.publicKey, mint: info, escrow: escrowAddress(sender.publicKey, id2) }));
    assert.equal(await tokenBalance(info, senderToken), before);
    assert.equal(await connection.getAccountInfo(vaultAddress(escrowAddress(sender.publicKey, id2))), null);
  });

  test(`${name}: a token transfer cannot be verified as SOL, nor by the wrong wallet`, async () => {
    const { info, senderToken } = await tokenWithBalance({ tokenProgram, decimals: 0, supply: 10n });
    const recipient = await funded(1);
    const id = newTransferId();
    await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 5n }));
    const escrow = escrowAddress(sender.publicKey, id);
    await rejects(run(recipient, claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow })), /different asset/);
    const stranger = await funded(1);
    await rejects(run(stranger, claimTokenIx({ recipient: stranger.publicKey, sender: sender.publicKey, mint: info, escrow })), /Only the recipient can verify/);
    await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow }));
  });
}

test('Token-2022 transfer fee: the escrow records what arrived, the withheld fee is harvested so the vault closes', async () => {
  const transferFee = (mint: PublicKey) => [createInitializeTransferFeeConfigInstruction(
    mint, sender.publicKey, sender.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID)]; // 1%
  const { info, senderToken } = await tokenWithBalance({
    tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 10_000_000n,
    extensions: { types: [ExtensionType.TransferFeeConfig], init: transferFee },
  });
  assert.deepEqual(info.transferFee, { basisPoints: 100, maximum: 1_000_000_000n });
  assert.equal(transferFeeOf(info, 1_000_000n), 10_000n);

  // Claim
  const recipient = await funded(1);
  const id = newTransferId();
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 1_000_000n }));
  const escrow = escrowAddress(sender.publicKey, id);
  assert.equal((await escrowOf(escrow))!.amount, 990_000n); // 1% withheld on the way in
  // Without the mint writable the withheld fee cannot be harvested: the claim fails as a whole (nothing moves)
  const readOnlyMint = claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: { ...info, transferFee: null }, escrow });
  await rejects(run(recipient, readOnlyMint), /writable privilege escalated|privilege escalated/i);
  assert.equal(await tokenBalance(info, vaultAddress(escrow)), 990_000n);
  await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow }));
  // 1% withheld again on the way out (the recipient's account holds it until the issuer collects it)
  const received = await getAccount(connection, ata(info, recipient.publicKey), 'confirmed', TOKEN_2022_PROGRAM_ID);
  assert.equal(received.amount, 990_000n - 9_900n);
  assert.equal(await connection.getAccountInfo(vaultAddress(escrow)), null);
  assert.equal(await connection.getAccountInfo(escrow), null);
  // The vault's withheld fee went to the mint
  const mint = await getMint(connection, info.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  assert.equal(getTransferFeeConfig(mint)!.withheldAmount, 10_000n);

  // Cancel
  const id2 = newTransferId();
  const before = await tokenBalance(info, senderToken);
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint: info, senderToken, id: id2, amount: 1_000_000n }));
  await run(sender, cancelTokenIx({ sender: sender.publicKey, mint: info, escrow: escrowAddress(sender.publicKey, id2) }));
  assert.equal(await tokenBalance(info, senderToken), before - 1_000_000n + 990_000n - 9_900n);
  assert.equal(await connection.getAccountInfo(vaultAddress(escrowAddress(sender.publicKey, id2))), null);
});

test('Token-2022 transfer hook: refused at send time (a hook could block the release), nothing is locked', async () => {
  const withHook = (program: PublicKey) => (mint: PublicKey) => [createInitializeTransferHookInstruction(mint, sender.publicKey, program, TOKEN_2022_PROGRAM_ID)];
  for (const program of [Keypair.generate().publicKey, PublicKey.default]) { // a hook now, or one the authority can set later
    const { info, senderToken } = await tokenWithBalance({
      tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 100n, decimals: 0,
      extensions: { types: [ExtensionType.TransferHook], init: withHook(program) },
    });
    assert.equal(info.transferHook, true);
    const id = newTransferId();
    await rejects(run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint: info, senderToken, id, amount: 10n })), /transfer hook are not supported/);
    assert.equal(await tokenBalance(info, senderToken), 100n);
    assert.equal(await connection.getAccountInfo(escrowAddress(sender.publicKey, id)), null);
  }
});

test('Token-2022 permanent delegate: if the issuer moves tokens out of the vault, claim and cancel still work', async () => {
  const delegate = (mint: PublicKey) => [createInitializePermanentDelegateInstruction(mint, sender.publicKey, TOKEN_2022_PROGRAM_ID)];
  const { info, senderToken } = await tokenWithBalance({
    tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 1_000n, decimals: 0,
    extensions: { types: [ExtensionType.PermanentDelegate], init: delegate },
  });
  assert.equal(info.permanentDelegate, true);
  const recipient = await funded(1);
  for (const [taken, release] of [[400n, 'claim'], [600n, 'cancel']] as const) {
    const id = newTransferId();
    await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 600n }));
    const escrow = escrowAddress(sender.publicKey, id);
    // The delegate (here the sender, as issuer) takes some or all of the vault
    await transferChecked(connection, sender, vaultAddress(escrow), info.mint, senderToken, sender, taken, 0, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
    const before = release === 'claim' ? await tokenBalance(info, ata(info, recipient.publicKey)) : await tokenBalance(info, senderToken);
    if (release === 'claim') await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow }));
    else await run(sender, cancelTokenIx({ sender: sender.publicKey, mint: info, escrow }));
    const after = release === 'claim' ? await tokenBalance(info, ata(info, recipient.publicKey)) : await tokenBalance(info, senderToken);
    assert.equal(after - before, 600n - taken);
    assert.equal(await connection.getAccountInfo(vaultAddress(escrow)), null);
    assert.equal(await connection.getAccountInfo(escrow), null);
  }
});

test('Token-2022 tokens that cannot be deposited fail the send as a whole: non-transferable, frozen by default', async () => {
  const nonTransferable = await tokenWithBalance({
    tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 100n, decimals: 0,
    extensions: { types: [ExtensionType.NonTransferable], init: (mint) => [createInitializeNonTransferableMintInstruction(mint, TOKEN_2022_PROGRAM_ID)] },
  });
  const frozen = await tokenWithBalance({
    tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 100n, decimals: 0, freezeAuthority: sender.publicKey,
    extensions: { types: [ExtensionType.DefaultAccountState], init: (mint) => [createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID)] },
  });
  for (const { info, senderToken } of [nonTransferable, frozen]) {
    const id = newTransferId();
    await rejects(run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint: info, senderToken, id, amount: 10n })), /Transfer is disabled for this mint|Account is frozen/);
    assert.equal(await tokenBalance(info, senderToken), 100n);
    assert.equal(await connection.getAccountInfo(escrowAddress(sender.publicKey, id)), null);
  }
});

test('a vault frozen by the issuer blocks the claim only until it is thawed', async () => {
  const { info, senderToken } = await tokenWithBalance({ tokenProgram: TOKEN_2022_PROGRAM_ID, supply: 100n, decimals: 0, freezeAuthority: sender.publicKey });
  const recipient = await funded(1);
  const id = newTransferId();
  await run(sender, ...sendTokenIxs({ sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 40n }));
  const escrow = escrowAddress(sender.publicKey, id);
  await freezeAccount(connection, sender, vaultAddress(escrow), info.mint, sender, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
  await rejects(run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow })), /Account is frozen/);
  await thawAccount(connection, sender, vaultAddress(escrow), info.mint, sender, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
  await run(recipient, claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow }));
  assert.equal(await tokenBalance(info, ata(info, recipient.publicKey)), 40n);
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
