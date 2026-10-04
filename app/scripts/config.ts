// Shows or changes Safe Send's fee configuration (the Config account of the program).
//
//   node scripts/config.ts show                                       [--rpc <url>]
//   node scripts/config.ts init <keypair> --treasury <address>        [--rpc <url>]  (upgrade authority, once)
//   node scripts/config.ts set  <keypair> [--fee-bps N] [--flat-sol X] [--treasury <address>] [--admin <address>] [--rpc <url>]
//
// <keypair> is the admin's keypair file (for init: the program's upgrade authority). --fee-bps is the share of
// each amount in basis points (30 = 0.3%, at most 100); --flat-sol a fixed SOL fee per send (at most 0.01).
// Options not given keep their current value. The default RPC is Devnet; for Mainnet pass --rpc.
// If the admin is a multisig (e.g. Squads), build the same update with updateConfigIx and propose it there.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  CONFIG_ADDRESS, MAX_FEE_BPS, MAX_FLAT_FEE_LAMPORTS, PROGRAM_ID, fetchConfig, initializeConfigIx, updateConfigIx, type FeeConfig,
} from '../src/lib/safeSend.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [command, keypairPath] = args;
const connection = new Connection(option('rpc') ?? 'https://api.devnet.solana.com', 'confirmed');
const loadKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

function print(config: FeeConfig) {
  console.log(`Program   ${PROGRAM_ID.toBase58()}`);
  console.log(`Config    ${CONFIG_ADDRESS.toBase58()}`);
  console.log(`Admin     ${config.admin.toBase58()}`);
  console.log(`Treasury  ${config.treasury.toBase58()}`);
  console.log(`Fee       ${config.feeBps} bps (${config.feeBps / 100}%) + ${Number(config.flatFeeLamports) / LAMPORTS_PER_SOL} SOL per send`);
}

if (command === 'show') {
  print(await fetchConfig(connection));
} else if (command === 'init') {
  const authority = loadKeypair(keypairPath);
  const treasury = new PublicKey(option('treasury') ?? authority.publicKey.toBase58());
  const signature = await sendAndConfirmTransaction(connection,
    new Transaction().add(initializeConfigIx({ authority: authority.publicKey, treasury })), [authority], { commitment: 'confirmed' });
  console.log(`Created: ${signature}`);
  print(await fetchConfig(connection));
} else if (command === 'set') {
  const admin = loadKeypair(keypairPath);
  const current = await fetchConfig(connection);
  const feeBps = option('fee-bps') !== undefined ? Number(option('fee-bps')) : current.feeBps;
  const flatFeeLamports = option('flat-sol') !== undefined ? BigInt(Math.round(Number(option('flat-sol')) * LAMPORTS_PER_SOL)) : current.flatFeeLamports;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) throw new Error(`--fee-bps must be 0..${MAX_FEE_BPS}`);
  if (flatFeeLamports < 0n || flatFeeLamports > MAX_FLAT_FEE_LAMPORTS) throw new Error('--flat-sol must be 0..0.01');
  const next: FeeConfig = {
    admin: new PublicKey(option('admin') ?? current.admin.toBase58()),
    treasury: new PublicKey(option('treasury') ?? current.treasury.toBase58()),
    feeBps,
    flatFeeLamports,
  };
  const signature = await sendAndConfirmTransaction(connection,
    new Transaction().add(updateConfigIx({ admin: admin.publicKey, config: next })), [admin], { commitment: 'confirmed' });
  console.log(`Updated: ${signature}`);
  print(await fetchConfig(connection));
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
