// Lists the open escrows of the program on a cluster: node scripts/list-escrows.ts [rpc-url]
import { Connection } from '@solana/web3.js';
import { PROGRAM_ID, decodeEscrow } from '../src/lib/safeSend.ts';

const connection = new Connection(process.argv[2] ?? 'https://api.devnet.solana.com', 'confirmed');
const accounts = await connection.getProgramAccounts(PROGRAM_ID);
console.log(`${accounts.length} program accounts`);
for (const { pubkey, account } of accounts) {
  const t = decodeEscrow(pubkey, account);
  console.log(pubkey.toBase58(), account.data.length, 'bytes', t ? `${t.isSol ? 'SOL' : t.mint.toBase58().slice(0, 4)} ${t.amount} from ${t.sender.toBase58().slice(0, 4)} to ${t.recipient.toBase58().slice(0, 4)}` : '(not an escrow)');
}
