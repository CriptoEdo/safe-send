// Tests of the dynamic compute budget (src/lib/fees.ts), on the same local validator as safeSend.test.ts.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import {
  BASE_FEE_LAMPORTS, MAX_CLAIM_PRIORITY_LAMPORTS, MAX_PRIORITY_LAMPORTS, MIN_MICRO_LAMPORTS, SimulationError,
  cappedPrice, claimPriorityCap, computeBudget, recentPrice,
} from '../src/lib/fees.ts';
import { checkRecipientFees, claimSolIx, escrowAddress, newTransferId, sendSolIx, topUpIx } from '../src/lib/safeSend.ts';

const connection = new Connection(process.env.TEST_RPC ?? 'http://127.0.0.1:8899', 'confirmed');

// The same validator, but as if the network were congested: every recent slot asked 50,000,000 micro-lamports
// per compute unit (thousands of times a normal fee).
const congested = new Proxy(connection, {
  get(target, prop) {
    if (prop === 'getRecentPrioritizationFees') {
      return async () => Array.from({ length: 150 }, (_, slot) => ({ slot, prioritizationFee: 50_000_000 }));
    }
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// An RPC that cannot simulate or estimate.
const broken = new Proxy(connection, {
  get(target, prop) {
    if (prop === 'simulateTransaction' || prop === 'getRecentPrioritizationFees') return async () => { throw new Error('RPC down'); };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

async function funded(sol = 10): Promise<Keypair> {
  const kp = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

const run = (signer: Keypair, ixs: TransactionInstruction[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: 'confirmed' });

async function feeOf(signature: string): Promise<{ fee: number; units: number }> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return { fee: tx!.meta!.fee, units: tx!.meta!.computeUnitsConsumed! };
}

let sender: Keypair;
before(async () => {
  sender = await funded(20);
});

test('price: 75th percentile of recent non-zero fees, never below the minimum', () => {
  assert.equal(recentPrice([]), MIN_MICRO_LAMPORTS);
  assert.equal(recentPrice([{ prioritizationFee: 0 }, { prioritizationFee: 0 }]), MIN_MICRO_LAMPORTS);
  const fees = [0, 0, 5_000, 10_000, 20_000, 40_000, 1_000_000].map((prioritizationFee) => ({ prioritizationFee }));
  assert.equal(recentPrice(fees), 40_000); // non-zero: 5k, 10k, 20k, 40k, 1M → index floor(5 × 0.75) = 3
  assert.equal(recentPrice([{ prioritizationFee: 10 }]), MIN_MICRO_LAMPORTS);
});

test('cap: the priority fee never exceeds the limit, and a negative budget means no priority fee', () => {
  assert.equal(cappedPrice(50_000_000, 100_000, 1_000_000), 10_000_000); // 100k units × 10 lamports = 1M
  assert.equal(cappedPrice(5_000, 100_000, 1_000_000), 5_000);
  assert.equal(cappedPrice(5_000, 100_000, -10), 0);
});

test('units are measured: the limit covers what the transaction uses, and it lands with it', async () => {
  const recipient = Keypair.generate();
  const ixs = [sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id: newTransferId(), lamports: 1_000_000n })];
  const budget = await computeBudget(connection, ixs, sender.publicKey);
  const { fee, units } = await feeOf(await run(sender, [...budget.instructions, ...ixs]));
  assert.ok(budget.units >= units, `limit ${budget.units} < used ${units}`);
  assert.ok(budget.units < 100_000, `limit ${budget.units} should be close to what a SOL send uses`);
  assert.ok(fee <= BASE_FEE_LAMPORTS + budget.priorityLamports);
});

test('congested network: a sender never pays more than the priority cap', async () => {
  const ixs = [sendSolIx({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: newTransferId(), lamports: 1_000_000n })];
  const budget = await computeBudget(congested, ixs, sender.publicKey);
  assert.ok(budget.priorityLamports <= MAX_PRIORITY_LAMPORTS);
  // Pays what the network asks for, up to the cap
  assert.equal(budget.microLamports, cappedPrice(50_000_000, budget.units, MAX_PRIORITY_LAMPORTS));
  assert.ok(budget.microLamports > 1_000 * MIN_MICRO_LAMPORTS);
  const { fee } = await feeOf(await run(sender, [...budget.instructions, ...ixs]));
  assert.ok(fee <= BASE_FEE_LAMPORTS + MAX_PRIORITY_LAMPORTS, `fee ${fee}`);
});

test('congested network: a recipient funded only with the top-up can still claim', async () => {
  const recipient = Keypair.generate(); // 0 SOL
  const check = await checkRecipientFees(connection, recipient.publicKey);
  const id = newTransferId();
  await run(sender, [topUpIx(sender.publicKey, recipient.publicKey, check.topUp), sendSolIx({ sender: sender.publicKey, recipient: recipient.publicKey, id, lamports: 500_000_000n })]);

  const cap = await claimPriorityCap(connection, recipient.publicKey);
  assert.ok(cap > 0 && cap <= MAX_CLAIM_PRIORITY_LAMPORTS, `cap ${cap}`);
  const ixs = [claimSolIx({ recipient: recipient.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) })];
  const budget = await computeBudget(congested, ixs, recipient.publicKey, cap);
  assert.ok(budget.priorityLamports <= cap);
  const { fee } = await feeOf(await run(recipient, [...budget.instructions, ...ixs]));
  assert.equal(await connection.getBalance(recipient.publicKey), check.topUp + 500_000_000 - fee);
  assert.ok(fee <= BASE_FEE_LAMPORTS + MAX_CLAIM_PRIORITY_LAMPORTS, `fee ${fee}`);
});

test('a transaction that would fail is caught by the simulation, before the wallet', async () => {
  const id = newTransferId();
  await run(sender, [sendSolIx({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, id, lamports: 1_000_000n })]);
  const stranger = await funded(1);
  const ixs = [claimSolIx({ recipient: stranger.publicKey, sender: sender.publicKey, escrow: escrowAddress(sender.publicKey, id) })];
  await assert.rejects(computeBudget(connection, ixs, stranger.publicKey), (err: SimulationError) => {
    assert.ok(err instanceof SimulationError);
    assert.match((err.logs ?? []).join('\n'), /Only the recipient can verify/);
    return true;
  });
});

test('RPC that cannot simulate: a fixed budget that still lands', async () => {
  const ixs = [sendSolIx({ sender: sender.publicKey, recipient: Keypair.generate().publicKey, id: newTransferId(), lamports: 1_000_000n })];
  const budget = await computeBudget(broken, ixs, sender.publicKey);
  assert.equal(budget.units, 200_000);
  assert.equal(budget.microLamports, MIN_MICRO_LAMPORTS);
  await run(sender, [...budget.instructions, ...ixs]);
});
