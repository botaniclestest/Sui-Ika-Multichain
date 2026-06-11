# Recovery Runbook

**Premise: the frontend no longer exists. Your laptop is gone. You have one
of the wallet's Sui signer keys and nothing else.**

Everything below works against any public Sui fullnode. No indexer, no
backend, no localStorage, no seed phrases, no dWallet share backups.

## What you need

1. Your Sui signer key (the one registered in the wallet's signer set).
2. The `policy_wallet` package id and registry id. These are public,
   non-secret constants. Find them in any of:
   - `deployments.json` in any copy/fork of this repo,
   - the Sui explorer (search any historic transaction of the wallet),
   - any co-signer,
   - on-chain: the package is permanent Sui state.

## Fast path (CLI)

```bash
git clone <this repo>   # or any rebuilt copy
pnpm install && pnpm --filter @mythos/wallet-core build
SUI_SECRET_KEY=suiprivkey1... pnpm recover testnet
```

This prints, from chain state alone:
- every wallet your address is a signer of (SignerCaps -> registry -> events),
- the full signer set, thresholds, timelocks, pause state,
- every chain policy (limits, windows, allow/block lists),
- every derived address — **re-derived from the Ika dWallet public outputs,
  not from any cache** — cross-checked against the on-chain address book,
- all pending spend requests and admin proposals,
- fee reserve balances.

## Fast path (web)

Deploy `apps/web` anywhere (it is a static site), or run `pnpm dev`,
open it with `?pkg=0x...&registry=0x...`, connect your wallet. The app has
no server and no database; it renders exactly the recovered state above.

## Why each step works

| Step | Durable source |
|---|---|
| "Which wallets am I in?" | Owned `SignerCap` objects (`getOwnedObjects` by type); the shared `Registry` table (address -> wallet ids); `WalletCreated`/`SignerAdded` events as a third redundancy. |
| "What are my addresses?" | The `PolicyWallet` object stores the dWallet ids; the Ika `DWallet` objects (shared Sui state) store the public outputs; addresses are pure functions of those public keys (P2WPKH script / keccak / base58). The on-chain address book is a cross-check, not a source of truth. |
| "What are the rules?" | All policy state lives in the shared `PolicyWallet` object (tables readable via standard dynamic-field RPC). |
| "What was pending?" | Requests/proposals are table entries inside the wallet object, including the exact bytes to sign and (for BTC) the aux serialization needed to reassemble the final transaction. |
| "Can I still sign?" | Yes: signing authority is the policy object itself. Shared-mode dWallets need no user-held secret; any signer can create/vote/execute from the recovered state. |

## Recovering from lost signers

- **Below threshold lost:** remaining signers create `RemoveSigner` /
  `AddSigner` proposals (admin threshold + admin timelock + veto window).
  Funds never move during rotation.
- **At/above threshold lost:** funds are unrecoverable by design — the same
  property that stops an attacker stops you. Mitigate ahead of time: choose
  `threshold < n`, distribute keys, consider a 2-of-3 or 3-of-5 layout, and
  keep the admin threshold reachable by survivors.

## Recovering mid-flight transactions

An executed request stores its Ika sign session ids. From any client:
1. read the request (`signIds`, `messages`, `aux`),
2. poll Ika for the completed signatures,
3. reassemble (BTC: `btcAssemblyFromRequest`; EVM: the message *is* the
   unsigned tx; Solana: the message *is* the wire message),
4. broadcast to the target chain.

The dashboard's "execute + broadcast" button and `scripts/e2e-testnet.ts`
both implement exactly this path.

## Drill it

Do not trust this document — rehearse it. Quarterly, from a machine that
has never seen the wallet:

```bash
SUI_SECRET_KEY=... pnpm recover mainnet
```

and verify every address shows `verified=true` and matches where your
funds actually sit.
