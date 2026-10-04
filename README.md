# Safe Send

**Send crypto on Solana that only arrives when the right person verifies it.**

A normal transfer to a mistyped address is lost forever. With Safe Send the funds are locked in an on-chain escrow until the recipient verifies the transfer from the wallet it was sent to. If nobody verifies it (wrong address, lost access, changed your mind), the sender cancels and gets everything back.

- **Network:** Solana **Devnet**
- **Program:** [`EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg`](https://explorer.solana.com/address/EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg?cluster=devnet)
- **Assets:** SOL and any token of the SPL Token program or Token-2022 (except tokens with a transfer hook)

## How it works

1. **Send.** The sender enters the recipient's address and an amount in the web app and signs with Phantom. The funds move into an escrow account (a PDA of the program) tied to that recipient.
2. **Verify.** The recipient opens Safe Send with their Phantom wallet: the transfer is listed under *To verify*. Clicking **Verify & receive** signs a `claim` transaction; the program checks the signer is exactly the recipient and releases the funds.
3. **Or cancel.** Until it is verified, the sender sees the transfer under *Sent, pending* and can **Cancel & refund** at any time.

The rent of the escrow accounts always returns to the sender, on verify or cancel.

### The recipient has no SOL for the fee

Verifying is a transaction, so the recipient pays a network fee (5,000 lamports), and a Solana account must also keep a minimum balance (rent-exempt minimum, ~0.00089 SOL). Before sending, the app checks the recipient's SOL balance:

- **enough SOL** (≥ rent-exempt minimum + 20,000 lamports of fee margin): nothing extra;
- **not enough**: the sender's transaction also sends the difference to the recipient (~0.00091 SOL for an empty wallet), in the same transaction as the transfer. The app says so before you sign. This small top-up is a normal transfer, so it is not refundable if the address was wrong.

For token transfers the recipient's token account is created by the sender at send time, so verifying never costs the recipient more than the fee.

## Program

`programs/safe_send/src/lib.rs` (Anchor 0.30.1):

| Instruction | Signer | Effect |
| --- | --- | --- |
| `send_sol(id, amount)` | sender | locks `amount` lamports in the escrow PDA `["escrow", sender, id]` |
| `claim_sol()` | recipient | lamports to the recipient, escrow rent to the sender |
| `cancel_sol()` | sender | everything back to the sender |
| `send_token(id, amount)` | sender | locks tokens in the vault PDA `["vault", escrow]` (the app creates the recipient's token account in the same transaction) |
| `claim_token()` | recipient | tokens to the recipient, rent of escrow and vault to the sender |
| `cancel_token()` | sender | tokens and rent back to the sender |

Checks: only the recipient can claim (`NotRecipient`), only the sender can cancel, the asset must match (`WrongAsset`), no self-transfers (`SelfTransfer`), no zero amounts (`ZeroAmount`). The app also refuses program addresses as recipients (they cannot sign, so nobody could verify).

## App

`app/` is a static Vite + TypeScript site. `app/src/lib/safeSend.ts` builds the program's instructions and decodes escrows by hand (Anchor discriminators + Borsh layout), so it needs no IDL; `app/src/main.ts` is the UI.

```bash
cd app
npm install
npm run dev          # http://localhost:5173 (uses Devnet; VITE_RPC_URL to change the RPC)
```

On Vercel the app uses `VITE_HELIUS_DEVNET_RPC_URL` (Helius Devnet RPC, key restricted to our domains in Helius;
`VITE_` values are public by design). `HELIUS_MAINNET_RPC_URL` is a server-only secret kept for a future mainnet RPC proxy.

```bash
npm run build        # static files in app/dist, deployable on Vercel, Netlify or GitHub Pages
```

Phantom must be set to Devnet: Settings → Developer settings → Testnet mode → Solana Devnet.

## Build, test, deploy

The program builds in WSL/Linux with Solana CLI 2.0 and Anchor 0.30.1. Current crates need a newer Rust than Solana's toolchain, so `.cargo/config.toml` picks Rust 1.75-compatible versions and `Cargo.lock` pins `blake3`, `jobserver` and `proc-macro2`.

```bash
anchor build
# end-to-end tests against a local validator
# (upgradeable, with the throwaway test authority, so the tests can create the fee Config: see app/test/fixtures)
solana-test-validator --reset --upgradeable-program EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg target/deploy/safe_send.so 8igxrcwdyKwhBbvxs8WZmXGugvaMgDZ9Fu2w6TSyjnKC
cd app && npm test
# UI tests: the real app with a fake Phantom that signs with test keypairs, against the same local validator
cd app && VITE_RPC_URL=http://127.0.0.1:8899 npx vite
#   open http://localhost:5173/test/ui/harness.html, then in the browser console:
#   await harness.setup(2); location.reload();   and after the reload:   await runSuite()
# deploy to Devnet (needs ~2x the program size in rent, see `solana rent`)
solana program deploy target/deploy/safe_send.so --program-id target/deploy/safe_send-keypair.json --url devnet
# then, once per network, create the fee Config (no fees) with the upgrade authority
cd app && node scripts/config.ts init <authority-keypair.json> --treasury <treasury-address>
```

## Limits

- The top-up for the recipient's fee is not refundable if the address is wrong (it is ~0.0009 SOL). A relayer that pays the claim fee and gets reimbursed from the escrow would avoid it.
- Safe Send fee (off today): the Config PDA `["config"]` holds `fee_bps` (share of the amount, in what is sent) and `flat_fee_lamports` (SOL), paid by the sender on top of the amount and moved to the treasury at send time (not refunded on cancel). Both are 0; the program caps them at 1% and 0.01 SOL. Only the program's upgrade authority can create the Config; its admin changes it with `update_config` — `node scripts/config.ts show | init <keypair> --treasury <addr> | set <keypair> --fee-bps 30 --flat-sol 0.001 [--treasury <addr>] [--admin <addr>] [--rpc <url>]`. Hand the admin to a multisig with `--admin`.
- Fees: every transaction sets its own compute budget (`app/src/lib/fees.ts`): units measured by simulating it (+15%), price from `getRecentPrioritizationFees` on the accounts it writes (75th percentile, at least 1,000 micro-lamports). The priority fee is capped at 0.001 SOL for senders, and for claims at what the recipient can pay above the rent-exempt minimum (≤ 90,000 lamports, within the top-up). The simulation also catches failing transactions before the wallet opens.
- Token-2022: transfer-fee tokens are supported (the escrow records what reached the vault; the fee withheld in the vault is harvested to the mint so it can close, which needs the mint writable in claim/cancel). Tokens with a transfer hook are refused at send time, since a hook (even one set later) could block the release. With a permanent delegate the issuer can move tokens out of the vault; the release moves whatever is left. Tokens that cannot be deposited (non-transferable, frozen by default) fail the send as a whole.
- Transfers have no expiry: the sender cancels by hand.
