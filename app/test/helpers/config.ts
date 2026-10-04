// The fee Config on the local test validator, where the program's upgrade authority is the throwaway key in
// test/fixtures (see its README). Tests start from no fees; the ones that set fees restore them.
import { readFileSync } from 'node:fs';
import { Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, type Connection } from '@solana/web3.js';
import { fetchConfig, initializeConfigIx, updateConfigIx, type FeeConfig } from '../../src/lib/safeSend.ts';

export const LOCAL_AUTHORITY = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(readFileSync(new URL('../fixtures/local-authority.json', import.meta.url), 'utf8')),
));

// Creates the Config if missing (admin and treasury: the local authority) and returns it.
export async function ensureConfig(connection: Connection): Promise<FeeConfig> {
  try {
    return await fetchConfig(connection);
  } catch {
    if ((await connection.getBalance(LOCAL_AUTHORITY.publicKey)) < LAMPORTS_PER_SOL) {
      await connection.confirmTransaction(await connection.requestAirdrop(LOCAL_AUTHORITY.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
    }
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(
        initializeConfigIx({ authority: LOCAL_AUTHORITY.publicKey, treasury: LOCAL_AUTHORITY.publicKey })), [LOCAL_AUTHORITY], { commitment: 'confirmed' });
    } catch (err) {
      // Another test file may have created it meanwhile
      if (!/already in use/.test(String(err))) throw err;
    }
    return fetchConfig(connection);
  }
}

export async function setConfig(connection: Connection, changes: Partial<FeeConfig>): Promise<FeeConfig> {
  const config = { ...(await ensureConfig(connection)), ...changes };
  await sendAndConfirmTransaction(connection, new Transaction().add(
    updateConfigIx({ admin: LOCAL_AUTHORITY.publicKey, config })), [LOCAL_AUTHORITY], { commitment: 'confirmed' });
  return fetchConfig(connection);
}
