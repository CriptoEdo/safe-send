// Tests of the fee Config: who can create and change it, the fee bounds, and what senders, recipients and the
// treasury get with fees on. Runs on the local validator with the program loaded as upgradeable, with the
// throwaway authority in test/fixtures (see its README). Fees are restored to zero at the end.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  createMint, getAccount, getAssociatedTokenAddressSync, getMintLen, getOrCreateAssociatedTokenAccount, mintTo, ExtensionType,
} from '@solana/spl-token';
import {
  CONFIG_ADDRESS, cancelSolIx, claimSolIx, claimTokenIx, escrowAddress, fetchConfig, initializeConfigIx, mintInfos,
  newTransferId, outgoingTransfers, sendSolIx, sendTokenIxs, updateConfigIx, type FeeConfig, type MintInfo,
} from '../src/lib/safeSend.ts';
import { LOCAL_AUTHORITY, ensureConfig, setConfig } from './helpers/config.ts';

const connection = new Connection(process.env.TEST_RPC ?? 'http://127.0.0.1:8899', 'confirmed');

async function funded(sol = 10): Promise<Keypair> {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

const run = (signers: Keypair[], ...ixs: TransactionInstruction[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });

async function rejects(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, (err: Error & { logs?: string[] }) => {
    assert.match(`${err.message}\n${(err.logs ?? []).join('\n')}`, message);
    return true;
  });
}

const feeOf = async (signature: string) =>
  (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.meta!.fee;
const balance = (k: PublicKey) => connection.getBalance(k);
const rent = (bytes: number) => connection.getMinimumBalanceForRentExemption(bytes);

let sender: Keypair;
let treasury: Keypair;

before(async () => {
  // On a fresh validator nobody but the upgrade authority can create the Config
  if (!(await connection.getAccountInfo(CONFIG_ADDRESS))) {
    const intruder = await funded(1);
    await rejects(run([intruder], initializeConfigIx({ authority: intruder.publicKey, treasury: intruder.publicKey })), /Only the admin/);
    assert.equal(await connection.getAccountInfo(CONFIG_ADDRESS), null);
  }
  await ensureConfig(connection);
  sender = await funded(50);
  treasury = Keypair.generate();
  await setConfig(connection, { treasury: treasury.publicKey, feeBps: 0, flatFeeLamports: 0n, admin: LOCAL_AUTHORITY.publicKey });
});

after(async () => {
  await setConfig(connection, { treasury: LOCAL_AUTHORITY.publicKey, feeBps: 0, flatFeeLamports: 0n, admin: LOCAL_AUTHORITY.publicKey });
});

test('the Config starts with no fees and only the admin can change it', async () => {
  const config = await fetchConfig(connection);
  assert.equal(config.feeBps, 0);
  assert.equal(config.flatFeeLamports, 0n);
  assert.ok(config.admin.equals(LOCAL_AUTHORITY.publicKey));
  const intruder = await funded(1);
  await rejects(run([intruder], updateConfigIx({ admin: intruder.publicKey, config: { ...config, admin: intruder.publicKey, feeBps: 100 } })), /Only the admin/);
  await rejects(run([LOCAL_AUTHORITY], initializeConfigIx({ authority: LOCAL_AUTHORITY.publicKey, treasury: intruder.publicKey })), /already in use/);
});

test('fees above the limits fixed in the program are refused (1%, 0.01 SOL)', async () => {
  const config = await fetchConfig(connection);
  await rejects(run([LOCAL_AUTHORITY], updateConfigIx({ admin: LOCAL_AUTHORITY.publicKey, config: { ...config, feeBps: 101 } })), /above the maximum/);
  await rejects(run([LOCAL_AUTHORITY], updateConfigIx({ admin: LOCAL_AUTHORITY.publicKey, config: { ...config, flatFeeLamports: 10_000_001n } })), /above the maximum/);
  const max = await setConfig(connection, { feeBps: 100, flatFeeLamports: 10_000_000n });
  assert.equal(max.feeBps, 100);
  await setConfig(connection, { feeBps: 0, flatFeeLamports: 0n });
});

test('no fees: the treasury gets nothing', async () => {
  const config = await fetchConfig(connection);
  const id = newTransferId();
  await run([sender], sendSolIx({ config, sender: sender.publicKey, recipient: Keypair.generate().publicKey, id, lamports: BigInt(LAMPORTS_PER_SOL) }));
  assert.equal(await balance(treasury.publicKey), 0);
  await run([sender], cancelSolIx({ sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
});

test('SOL with fees: the sender pays on top, the recipient gets the exact amount, cancel does not refund the fee', async () => {
  const config = await setConfig(connection, { feeBps: 30, flatFeeLamports: 1_000_000n }); // 0.3% + 0.001 SOL
  const recipient = await funded(1);
  const amount = 2n * BigInt(LAMPORTS_PER_SOL);
  const fee = 6_000_000 + 1_000_000;
  const escrowRent = await rent(194);

  const before = await balance(sender.publicKey);
  const id = newTransferId();
  const send = await run([sender], sendSolIx({ config, sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: amount }));
  assert.equal(await balance(sender.publicKey), before - Number(amount) - fee - escrowRent - await feeOf(send));
  assert.equal(await balance(treasury.publicKey), fee);

  const recipientBefore = await balance(recipient.publicKey);
  const claim = await run([recipient], claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) }));
  assert.equal(await balance(recipient.publicKey), recipientBefore + Number(amount) - await feeOf(claim));

  // Cancel: the amount and the rent come back, the fee stays with the treasury
  const id2 = newTransferId();
  const before2 = await balance(sender.publicKey);
  const send2 = await run([sender], sendSolIx({ config, sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: id2, lamports: amount }));
  const cancel = await run([sender], cancelSolIx({ sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id2) }));
  assert.equal(await balance(sender.publicKey), before2 - fee - await feeOf(send2) - await feeOf(cancel));
  assert.equal(await balance(treasury.publicKey), 2 * fee);
});

test('the fee must go to the treasury in the Config', async () => {
  const config = await setConfig(connection, { feeBps: 30, flatFeeLamports: 0n });
  const elsewhere = Keypair.generate().publicKey;
  await rejects(run([sender], sendSolIx({ config: { ...config, treasury: elsewhere }, sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: newTransferId(), lamports: 1_000_000n })), /treasury account does not match/);
});

async function token(tokenProgram: PublicKey, transferFeeBps = 0): Promise<{ info: MintInfo; senderToken: PublicKey }> {
  let mint: PublicKey;
  if (transferFeeBps) {
    const kp = Keypair.generate();
    mint = kp.publicKey;
    const space = getMintLen([ExtensionType.TransferFeeConfig]);
    await run([sender, kp],
      SystemProgram.createAccount({ fromPubkey: sender.publicKey, newAccountPubkey: mint, space, lamports: await rent(space), programId: tokenProgram }),
      createInitializeTransferFeeConfigInstruction(mint, sender.publicKey, sender.publicKey, transferFeeBps, 10n ** 15n, tokenProgram),
      createInitializeMintInstruction(mint, 6, sender.publicKey, null, tokenProgram));
  } else {
    mint = await createMint(connection, sender, sender.publicKey, null, 6, undefined, { commitment: 'confirmed' }, tokenProgram);
  }
  const senderToken = (await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey, false, 'confirmed', undefined, tokenProgram)).address;
  await mintTo(connection, sender, mint, senderToken, sender, 1_000_000_000n, [], { commitment: 'confirmed' }, tokenProgram);
  return { info: (await mintInfos(connection, [mint])).get(mint.toBase58())!, senderToken };
}

const tokenBalance = async (info: MintInfo, owner: PublicKey) =>
  (await getAccount(connection, getAssociatedTokenAddressSync(info.mint, owner, true, info.tokenProgram), 'confirmed', info.tokenProgram)).amount;

for (const [name, program] of [['SPL Token', TOKEN_PROGRAM_ID], ['Token-2022', TOKEN_2022_PROGRAM_ID]] as const) {
  test(`${name} with fees: 1% in tokens to the treasury's account (created in the same transaction), flat fee in SOL`, async () => {
    const config = await setConfig(connection, { feeBps: 100, flatFeeLamports: 1_000_000n });
    const { info, senderToken } = await token(program);
    const recipient = await funded(1);
    const treasuryBefore = await balance(treasury.publicKey);
    const id = newTransferId();
    await run([sender], ...sendTokenIxs({ config, sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 50_000_000n }));
    assert.equal(await tokenBalance(info, sender.publicKey), 1_000_000_000n - 50_000_000n - 500_000n);
    assert.equal(await tokenBalance(info, treasury.publicKey), 500_000n);
    assert.equal(await balance(treasury.publicKey), treasuryBefore + 1_000_000);
    await run([recipient], claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow: escrowAddress(sender.publicKey, id) }));
    assert.equal(await tokenBalance(info, recipient.publicKey), 50_000_000n); // the exact amount
  });
}

test('Token-2022 with its own transfer fee and our fee: each transfer pays the token fee, the recipient gets the escrow minus it', async () => {
  const config = await setConfig(connection, { feeBps: 100, flatFeeLamports: 0n });
  const { info, senderToken } = await token(TOKEN_2022_PROGRAM_ID, 50); // the token takes 0.5% per transfer
  const recipient = await funded(1);
  const id = newTransferId();
  await run([sender], ...sendTokenIxs({ config, sender: sender.publicKey, recipient: recipient.publicKey, mint: info, senderToken, id, amount: 10_000_000n }));
  // Our 1% fee (100,000) arrives minus the token's 0.5%; the escrow holds 10,000,000 minus 0.5%
  assert.equal(await tokenBalance(info, treasury.publicKey), 100_000n - 500n);
  assert.equal((await outgoingTransfers(connection, sender.publicKey)).find((t) => t.address.equals(escrowAddress(sender.publicKey, id)))!.amount, 9_950_000n);
  await run([recipient], claimTokenIx({ recipient: recipient.publicKey, sender: sender.publicKey, mint: info, escrow: escrowAddress(sender.publicKey, id) }));
  assert.equal(await tokenBalance(info, recipient.publicKey), 9_950_000n - 49_750n);
});

test("a percentage fee on tokens needs the treasury's token account", async () => {
  const config = await setConfig(connection, { feeBps: 100, flatFeeLamports: 0n });
  const { info, senderToken } = await token(TOKEN_PROGRAM_ID);
  // Built as if there were no fee: no treasury token account in the instruction
  const ixs = sendTokenIxs({ config: { ...config, feeBps: 0 }, sender: sender.publicKey, recipient: Keypair.generate().publicKey, mint: info, senderToken, id: newTransferId(), amount: 10_000_000n });
  await rejects(run([sender], ...ixs), /treasury's token account is required/);
});

test('changing the treasury and handing the admin role over (e.g. to a multisig)', async () => {
  const newTreasury = Keypair.generate();
  const config = await setConfig(connection, { treasury: newTreasury.publicKey, feeBps: 0, flatFeeLamports: 1_000_000n });
  await run([sender], sendSolIx({ config, sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: newTransferId(), lamports: 1_000_000n }));
  assert.equal(await balance(newTreasury.publicKey), 1_000_000);

  const newAdmin = await funded(1);
  await setConfig(connection, { admin: newAdmin.publicKey });
  // The old admin can no longer change anything; the new one can
  await rejects(run([LOCAL_AUTHORITY], updateConfigIx({ admin: LOCAL_AUTHORITY.publicKey, config: { ...config, admin: LOCAL_AUTHORITY.publicKey } })), /Only the admin/);
  await run([newAdmin], updateConfigIx({ admin: newAdmin.publicKey, config: { ...(await fetchConfig(connection)), admin: LOCAL_AUTHORITY.publicKey } }));
  assert.ok((await fetchConfig(connection)).admin.equals(LOCAL_AUTHORITY.publicKey));
});
