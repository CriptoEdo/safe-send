# Mainnet launch checklist

**Status (2026-10-04):** steps 1–5 done. The program is live on Mainnet, built from commit `bbfa02f` and verified
([OtterSec](https://verify.osec.io/status/EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg), hash `67af2ad3…6767`);
the fee Config exists with no fees. Remaining: step 6 (switch the site) and step 7.

Everything here runs from the `mainnet` branch. The Devnet version stays on `main`/`devnet` (tag
`hackathon-devnet-v1`) and live at www.safe-send.app until step 6.

Keys and addresses:

| What | Value |
| --- | --- |
| Program ID (same on every network) | `EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg` (keypair: `target/deploy/safe_send-keypair.json`) |
| Deployer, upgrade authority, Config admin | `BVi2jbXTgmzFauGriBRFzxy8zugYiB4ssqwBTid8qcgD` (WSL `/root/.config/solana/id.json`, backup on USB) |
| Config PDA | `3PpDRvsx3xih7MCrr5A4ZGpo9tpwa9yhhWKqFfgPYYch` |
| Treasury (Mainnet) | `HoLp715VudB6E9xE22oLtTUuvaddsCDyWkqrK5K75GAo` |

## 1. Verifiable build (needs Docker)

```bash
cargo +stable install solana-verify --locked
solana-verify build --library-name safe_send     # builds in Docker, writes target/deploy/safe_send.so
solana-verify get-executable-hash target/deploy/safe_send.so
```

The same commit always gives the same hash, so anyone can check the deployed program against GitHub. Run the
tests against this file before deploying (it is built with Solana's toolchain in Docker, not the local one).

## 2. Fund the deployer and deploy

Send ~4 SOL on Mainnet to `BVi2…cgD` (first 0.01 as a test). The program account keeps ~1.95 SOL of rent;
the deploy buffer (~1.95 SOL) is refunded at the end. The first deploy cost 1.947 SOL in total.

```bash
solana balance --url mainnet-beta
solana program deploy target/deploy/safe_send.so \
  --program-id target/deploy/safe_send-keypair.json \
  --url mainnet-beta --with-compute-unit-price 50000 --max-sign-attempts 50
solana program show EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg --url mainnet-beta
```

If the deploy stops halfway, run the same command again (it resumes from the buffer), or recover the buffer's
SOL with `solana program close --buffers --url mainnet-beta`. For an upgrade that makes the program bigger,
first `solana program extend <program-id> <bytes ≥ 10240>`.

## 3. Create the fee Config (no fees)

```bash
cd app
node scripts/config.ts init <deployer-keypair.json> --treasury <mainnet-treasury-address> --rpc https://api.mainnet-beta.solana.com
node scripts/config.ts show --rpc https://api.mainnet-beta.solana.com
```

## 4. Verify on-chain against GitHub

```bash
solana-verify verify-from-repo -u https://api.mainnet-beta.solana.com \
  --program-id EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg https://github.com/CriptoEdo/safe-send \
  --commit-hash <commit> --library-name safe_send -k <authority-keypair.json> -y
solana-verify remote submit-job --url https://api.mainnet-beta.solana.com \
  --program-id EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg --uploader BVi2jbXTgmzFauGriBRFzxy8zugYiB4ssqwBTid8qcgD
```

The first rebuilds from GitHub in Docker, checks the hash against the chain and stores the build parameters
on-chain (signed by the upgrade authority); the second has OtterSec confirm it, so Solana Explorer shows the
program as verified. Repeat both after every upgrade.

## 5. Smoke test with small amounts

`RPC_URL=https://api.mainnet-beta.solana.com node scripts/devnet-smoke.ts <deployer-keypair.json>` sends 0.01 SOL
with a top-up to a new wallet, claims it (and returns that wallet's SOL), then sends to a wrong address and cancels.

## 6. Switch the site to Mainnet (Vercel)

1. Settings → Environment Variables:
   - `VITE_CLUSTER` = `mainnet-beta` — **Production**, and **Preview for the branch `mainnet`** (to try the
     Mainnet site on its preview URL before launch).
   - `HELIUS_MAINNET_RPC_URL` — Production, and Preview for the branch `mainnet` (Sensitive, server only).
   - `VITE_HELIUS_DEVNET_RPC_URL` — also **Preview for the branch `devnet`** (the Devnet site below).
2. Try the `mainnet` preview (safe-send-git-mainnet-…vercel.app) with Phantom on Mainnet: a 0.001 SOL send to
   your second wallet, claim it, then a cancel.
3. Settings → Domains: add `devnet.safe-send.app`, assigned to the git branch `devnet` (the hackathon Devnet
   app keeps working there). In Helius, add `devnet.safe-send.app` to the Devnet key's Allowed Domains.
4. Merge `mainnet` into `main` → Vercel deploys www.safe-send.app on Mainnet.
5. Check: no "Devnet" badge, `/api/rpc` answers, a 0.001 SOL send and claim work.

## 7. After launch

- Before turning a fee on, send the treasury at least 0.001 SOL: a transfer smaller than the rent-exempt minimum
  (~0.00089 SOL) to an account that does not exist yet is refused, so small percentage fees would fail.
- Watch the program: Helius webhooks on the program ID (the TransferSent/Claimed/Cancelled events).
- Move the upgrade authority and the Config admin to a Squads multisig before escrows hold significant funds:
  `solana program set-upgrade-authority … --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check`
  and `node scripts/config.ts set <key> --admin <vault>`.
- Leftover SOL on the deployer: `solana transfer <your-wallet> <amount> --url mainnet-beta`.
