# Mythos Multichain Policy Wallet

A persistent, recoverable, policy-controlled multichain wallet.
**Sui mainnet is the control plane; Ika dWallets/MPC are the signing plane.**

Hold and send **BTC**, **EVM assets** (ETH, L2s, ERC-20), **Solana**, and
**Sui assets** from one wallet governed by one on-chain policy: m-of-n
signers, per-chain spend limits, rolling windows, timelocks, allow/block
lists, request expiry, emergency pause, and timelocked + vetoable
governance.

There is nothing to back up except your Sui signer keys. If this website,
your browser profile and your laptop all disappear, any signer recovers
every address, rule and pending request from public Sui state
(see [docs/RECOVERY.md](docs/RECOVERY.md)).

> **Honesty first:** the code is complete and tested (42 Move tests,
> 17 TypeScript tests with byte-exact cross-checks), but it is **not
> audited** and has not had a mainnet burn-in. Read
> [docs/SECURITY.md](docs/SECURITY.md) before holding real value.

## Layout

```
contracts/policy_wallet/   Move package: policy, custody, verifiers, registry, vault
contracts/vendor/          pinned Ika Move deps (testnet + mainnet)
packages/core/             @mythos/wallet-core: adapters, Ika service, PTBs, recovery
apps/web/                  static web app: creation wizard + dashboard
scripts/                   publish.ts, e2e-testnet.ts, recover.ts
docs/                      ARCHITECTURE.md, SECURITY.md, RECOVERY.md
deployments.json           public deployment constants (commit this)
```

## Quick start

```bash
pnpm install

# tests
pnpm --filter @mythos/wallet-core test     # 17 TS tests
pnpm test:move                             # 42 Move tests

# deploy (sui CLI configured for testnet, gas funded)
pnpm publish:testnet                       # writes deployments.json

# full lifecycle drill on testnet (needs SUI gas + IKA tokens)
SUI_SECRET_KEY=suiprivkey1... pnpm e2e:testnet

# recovery drill - the "frontend disappeared" scenario
SUI_SECRET_KEY=suiprivkey1... pnpm recover testnet

# web app
pnpm dev
```

## How a spend works

1. Any signer drafts a transfer. The client builds the **exact bytes** the
   target chain needs (BIP-143 preimages / unsigned EIP-1559 tx / Solana
   message) and submits them in `create_spend_request`.
2. The Move contract **parses those bytes on-chain** and proves they pay
   the declared amount to the declared destination within fee limits —
   then locks Ika future-sign capabilities against them.
3. Signers vote. Each signer's client independently re-verifies the bytes
   before enabling the approve button. Rejections kill the fast path;
   enough rejections kill the request.
4. After threshold (+ timelock for large spends), `execute_spend`
   re-validates everything, records the spend against the rolling window,
   and only then produces the Ika `MessageApproval`s.
5. Ika returns 64-byte signatures; any signer assembles and broadcasts the
   final transaction — all assembly context is stored on-chain.

Sui assets skip steps 2-5's signing machinery entirely: they sit in a vault
inside the wallet object and transfer natively under the same voting,
limits and timelocks.

## Mainnet

Switch `contracts/policy_wallet/Move.toml` deps to `../vendor/mainnet/...`,
run `pnpm publish:mainnet`, and work through the mainnet checklist at the
bottom of [docs/SECURITY.md](docs/SECURITY.md) — including the audit.
