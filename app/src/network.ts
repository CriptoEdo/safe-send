// Which Solana network the app runs on, chosen at build time with VITE_CLUSTER ("mainnet-beta" or "devnet",
// the default). On Mainnet the app talks to the RPC through this site's /api/rpc proxy, which keeps the Helius
// key on the server (HELIUS_MAINNET_RPC_URL); on Devnet the browser calls Helius directly with a key restricted
// to our domains (VITE_HELIUS_DEVNET_RPC_URL). VITE_RPC_URL overrides both (e.g. a local validator for tests).
export type Cluster = 'devnet' | 'mainnet-beta';

export const CLUSTER: Cluster = import.meta.env.VITE_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
export const IS_MAINNET = CLUSTER === 'mainnet-beta';
// How the app names the network in messages ("Could not reach Solana").
export const NETWORK_NAME = IS_MAINNET ? 'Solana' : 'Solana Devnet';

export const RPC_URL: string = import.meta.env.VITE_RPC_URL
  ?? (IS_MAINNET ? `${location.origin}/api/rpc` : import.meta.env.VITE_HELIUS_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com');

export const explorer = (kind: 'tx' | 'address', id: string) =>
  `https://explorer.solana.com/${kind}/${id}${IS_MAINNET ? '' : '?cluster=devnet'}`;
