# Mainnet launch checklist

Everything here runs from the `mainnet` branch. The Devnet version stays on `main`/`devnet` (tag
`hackathon-devnet-v1`) and live at www.safe-send.app until step 6.

Keys and addresses:

| What | Value |
| --- | --- |
| Program ID (same on every network) | `EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg` (keypair: `target/deploy/safe_send-keypair.json`) |
| Deployer, upgrade authority, Config admin | `BVi2jbXTgmzFauGriBRFzxy8zugYiB4ssqwBTid8qcgD` (WSL `/root/.config/solana/id.json`, backup on USB) |
| Config PDA | `3PpDRvsx3xih7MCrr5A4ZGpo9tpwa9yhhWKqFfgPYYch` |
| Treasury | chosen at step 3 |

## 1. Verifiable build (needs Docker)

```bash
cargo install solana-verify
solana-verify build                      # builds in Docker, writes target/deploy/safe_send.so
solana-verify get-executable-hash target/deploy/safe_send.so
```

The same commit always gives the same hash, so anyone can check the deployed program against GitHub.

## 2. Fund the deployer and deploy

Send ~4 SOL on Mainnet to `BVi2…cgD` (first 0.01 as a test). The program account keeps ~1.95 SOL of rent;
the deploy buffer (~1.95 SOL) is refunded at the end.

```bash
solana balance --url mainnet-beta
solana program deploy target/deploy/safe_send.so \
  --program-id target/deploy/safe_send-keypair.json \
  --url <helius-mainnet-rpc-url> --with-compute-unit-price 50000 --max-sign-attempts 50
solana program show EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg --url mainnet-beta
```

If the deploy stops halfway, run the same command again (it resumes from the buffer), or recover the buffer's
SOL with `solana program close --buffers --url mainnet-beta`.

## 3. Create the fee Config (no fees)

```bash
cd app
node scripts/config.ts init <deployer-keypair.json> --treasury <mainnet-treasury-address> --rpc <helius-mainnet-rpc-url>
node scripts/config.ts show --rpc <helius-mainnet-rpc-url>
```

## 4. Verify on-chain against GitHub

```bash
solana-verify verify-from-repo -u <helius-mainnet-rpc-url> \
  --program-id EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg https://github.com/CriptoEdo/safe-send \
  --commit-hash <commit> --library-name safe_send --remote
```

`--remote` also registers the result with OtterSec's API, so Solana Explorer shows the program as verified.

## 5. Smoke test with small amounts

On the Mainnet preview of the `mainnet` branch (or locally with `VITE_CLUSTER=mainnet-beta`): send 0.001 SOL
and 0.10 USDC to a second wallet, claim one, cancel the other, check the escrows close and the explorer links.

## 6. Switch the site to Mainnet (Vercel)

1. Settings → Environment Variables:
   - `VITE_CLUSTER` = `mainnet-beta` — **Production** only.
   - `HELIUS_MAINNET_RPC_URL` — already set (Sensitive, server only).
   - `VITE_HELIUS_DEVNET_RPC_URL` — also for **Preview** (the Devnet site below is a preview branch).
2. Settings → Domains: add `devnet.safe-send.app`, assigned to the git branch `devnet` (the hackathon Devnet
   app keeps working there). In Helius, add `devnet.safe-send.app` to the key's Allowed Domains.
3. Merge `mainnet` into `main` → Vercel deploys www.safe-send.app on Mainnet.
4. Check: no "Devnet" badge, `/api/rpc` answers, a 0.001 SOL send and claim work.

## 7. After launch

- Watch the program: Helius webhooks on the program ID (the TransferSent/Claimed/Cancelled events).
- Move the upgrade authority and the Config admin to a Squads multisig before escrows hold significant funds:
  `solana program set-upgrade-authority … --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check`
  and `node scripts/config.ts set <key> --admin <vault>`.
- Leftover SOL on the deployer: `solana transfer <your-wallet> <amount> --url mainnet-beta`.
