# Test fixtures

`local-authority.json` is a throwaway keypair (8igxrcwdyKwhBbvxs8WZmXGugvaMgDZ9Fu2w6TSyjnKC) used **only** by the
local test validator, as the program's upgrade authority, so the tests can create and change the fee Config:

```bash
solana-test-validator --reset --upgradeable-program EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg \
  target/deploy/safe_send.so 8igxrcwdyKwhBbvxs8WZmXGugvaMgDZ9Fu2w6TSyjnKC
```

It is public on purpose: never use it on Devnet or Mainnet, never send it funds.
