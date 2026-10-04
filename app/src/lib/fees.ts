import {
  ComputeBudgetProgram, PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction,
  type Connection, type TransactionInstruction,
} from '@solana/web3.js';
import { CLAIM_FEE_LAMPORTS } from './safeSend.ts';

// Dynamic compute budget: how many compute units a transaction needs (measured by simulating it) and the
// priority fee per unit the network is asking for right now (recent fees on the accounts it writes). Wallets
// like Phantom add their own priority fee only when a transaction sets none, so the app's choice is the one used.

// Signature fee per signature, in lamports.
export const BASE_FEE_LAMPORTS = 5_000;
// The most a sender ever pays in priority fees for one transaction (0.001 SOL), however busy the network is.
export const MAX_PRIORITY_LAMPORTS = 1_000_000;
// The most a claim pays in priority fees: within CLAIM_FEE_LAMPORTS, so a recipient funded only with the
// top-up can always afford it (see claimPriorityCap).
export const MAX_CLAIM_PRIORITY_LAMPORTS = CLAIM_FEE_LAMPORTS - BASE_FEE_LAMPORTS - 5_000;
// Below this price a transaction risks waiting behind others even when the network is quiet.
export const MIN_MICRO_LAMPORTS = 1_000;
// Recent fees: the 75th percentile lands quickly without overpaying for the few most expensive slots.
const PERCENTILE = 0.75;
// Simulation measures the units used; the limit adds this much on top, as state can change before landing.
const UNITS_MARGIN = 1.15;
const MAX_UNITS = 1_400_000;

export interface ComputeBudget {
  units: number;
  microLamports: number; // price per compute unit
  priorityLamports: number; // units × price, what the priority fee costs at most
  instructions: TransactionInstruction[]; // to put first in the transaction
}

const budget = (units: number, microLamports: number): ComputeBudget => ({
  units,
  microLamports,
  priorityLamports: Math.ceil((units * microLamports) / 1_000_000),
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ],
});

// The price per unit the network is asking for transactions writing these accounts (percentile of the fees
// paid in recent slots), never below MIN_MICRO_LAMPORTS.
export function recentPrice(fees: { prioritizationFee: number }[]): number {
  const values = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
  if (values.length === 0) return MIN_MICRO_LAMPORTS;
  const value = values[Math.min(values.length - 1, Math.floor(values.length * PERCENTILE))];
  return Math.max(MIN_MICRO_LAMPORTS, value);
}

// The highest price per unit keeping the priority fee within `maxLamports`.
export function cappedPrice(price: number, units: number, maxLamports: number): number {
  const cap = Math.floor((Math.max(0, maxLamports) * 1_000_000) / units);
  return Math.max(0, Math.min(price, cap));
}

// The priority fee a claim can afford: the recipient pays the fee before the claim runs and must keep the
// rent-exempt minimum afterwards, so what is above minimum + signature fee, with a small margin, and never
// more than MAX_CLAIM_PRIORITY_LAMPORTS.
export async function claimPriorityCap(connection: Connection, payer: PublicKey): Promise<number> {
  const [balance, rentExempt] = await Promise.all([
    connection.getBalance(payer),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  return Math.min(MAX_CLAIM_PRIORITY_LAMPORTS, balance - rentExempt - BASE_FEE_LAMPORTS - 1_000);
}

// A program error found by the simulation, with its logs, so the app can explain it before asking Phantom.
export class SimulationError extends SendTransactionError {}

// Compute budget instructions for `instructions` (which must not set one): units measured by simulation, price
// from recent fees, priority fee within `maxPriorityLamports`. A program error in the simulation is thrown
// (the transaction would fail anyway); if the RPC cannot simulate or estimate, a fixed small budget is used.
export async function computeBudget(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  maxPriorityLamports = MAX_PRIORITY_LAMPORTS,
): Promise<ComputeBudget> {
  const writable = [...new Set(instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))]
    .slice(0, 128)
    .map((k) => new PublicKey(k));
  let simulation;
  let fees;
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(), // replaced by the RPC
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS }), ...instructions],
    }).compileToV0Message();
    [simulation, fees] = await Promise.all([
      connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true }),
      connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable }),
    ]);
  } catch {
    return fixedBudget(maxPriorityLamports);
  }
  if (simulation.value.err) {
    throw new SimulationError({
      action: 'simulate',
      signature: '',
      transactionMessage: `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
      logs: simulation.value.logs ?? [],
    });
  }
  const consumed = simulation.value.unitsConsumed;
  if (!consumed) return fixedBudget(maxPriorityLamports);
  // The two compute budget instructions cost 150 units each.
  const units = Math.min(MAX_UNITS, Math.ceil(consumed * UNITS_MARGIN) + 300);
  return budget(units, cappedPrice(recentPrice(fees), units, maxPriorityLamports));
}

// When the network cannot be asked: enough units for any Safe Send transaction, at the minimum price.
function fixedBudget(maxPriorityLamports: number): ComputeBudget {
  const units = 200_000;
  return budget(units, cappedPrice(MIN_MICRO_LAMPORTS, units, maxPriorityLamports));
}
