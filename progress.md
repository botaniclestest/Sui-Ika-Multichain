# Progress Handoff

Last updated: 2026-06-22

## Current State

- Product/site name is `stINKy Multichain Policy Wallet`.
- Current branch is `main`.
- `main` was pushed and aligned with `origin/main` at `816d761 docs: rename wallet branding` before the mainnet deployment update. New local deployment changes may still need commit/push.
- GitHub remote is `git@github.com:botaniclestest/Sui-Ika-Multichain.git`.
- Deleted the merged `feature/solana-durable-nonce` branch locally and on GitHub.
- Local `feature/visual-polish` branch still exists and is fully merged into `main`.

## What This Project Is

- A Sui Move policy wallet using Ika dWallets/MPC for native BTC, EVM, and Solana signing.
- Sui is the control plane: the `PolicyWallet` shared object owns the Ika `DWalletCap`s and stores policy, requests, proposals, address book, presign pools, and fee reserves.
- Ika is the signing plane: dWallets produce target-chain signatures only after the Move contract emits a valid `MessageApproval`.
- Sui assets use a native vault inside the wallet object and do not use Ika signing.
- Recovery is intended to be fully on-chain: any signer can rebuild wallets, addresses, policy, requests, and proposals from Sui RPC state.

## Ika Architecture Conclusion

- The project is using Ika as intended for a Move-controlled DAO/treasury/multisig style app.
- It uses shared dWallet mode, which Ika docs describe as the normal pattern for Move contracts, DAOs, treasuries, and automated systems.
- Spend requests use Ika future signing:
  - `create_spend_request` locks partial signatures to exact message bytes.
  - Signers vote under Sui policy.
  - `execute_spend` revalidates policy, emits `MessageApproval`, and requests final signatures.
- The main tradeoff is shared-mode security: there is no user-held secret to back up, but the design trusts the Ika validator threshold to enforce `MessageApproval`. This is documented in `docs/SECURITY.md`.

## Recent Completed Work

- Hardened Solana durable nonce flow and merged it into `main`.
- Added recovered chain balances.
- Added polished web visuals, coin assets, chain-reactive Send UI, and wallet menu layering fixes.
- Added governance UX improvements:
  - proposal creation uses hours instead of raw milliseconds for timelocks/expiry/window length.
  - governance destination inputs parse chain-native formats for BTC/EVM/Solana.
  - Set Chain Limits form is available in the governance UI.
  - proposal cards show human-readable decoded details for thresholds, timelocks, chain limits, allow/block list bytes, address book updates, and bool toggles.
  - proposal cards show voting/execution availability status.
  - UI warns that admin proposal execution uses the current `timelock_admin_ms`; changing the admin timelock can move already-approved pending proposal execution earlier or later.
- Added Address Book dashboard tab:
  - recorded chain identities.
  - derived address comparison and verification badges.
  - allowlist/blocklist entries grouped by chain.
  - raw bytes plus best-effort chain-native display.
- Normalized Sui address comparisons for signer/vote checks.
- Displayed rolling spend window state using effective reset logic.
- Renamed README/site title/header/landing title to `stINKy Multichain Policy Wallet`.
- Updated README with dashboard capability summary.

## Important Commits

- `816d761 docs: rename wallet branding`
- `ba81602 feat(web): surface governance policy details`
- `22b86b6 fix(web): map eip155 family to 'eth' so coin SVG loads`
- `51269a5 feat(web): drop in polished SVG coin assets`
- `dcfb111 feat(web): real 3D coin + refined chain logos`
- `1fa18b7 feat(web): spinning 3D chain coin on Send page`
- `6ea62e3 feat(web): sovereign-vault visual polish`
- `f90c0cf Show recovered chain balances`
- `649ee06 Merge Solana durable nonce flow`
- `7eb65d9 Harden Solana durable nonce flow`

## Verification Already Run

- `pnpm --filter @mythos/wallet-core typecheck`
- `pnpm --filter @mythos/wallet-core test`
- `pnpm test:move`
- `pnpm --filter @mythos/wallet-core build && pnpm --filter @mythos/web build`
- After latest branding change: `pnpm --filter @mythos/web build`

Known non-blocking build warnings:

- Vite warns that `packages/core/dist/index.js` is both dynamically and statically imported.
- Vite warns that some chunks are larger than 500 kB after minification.

## Key Files

- `contracts/policy_wallet/sources/policy_wallet.move`: canonical wallet policy, Ika custody/signing flow, admin governance, spend execution, timelock behavior.
- `contracts/policy_wallet/sources/verify_btc.move`: BTC BIP-143 intent verifier.
- `contracts/policy_wallet/sources/verify_evm.move`: EVM EIP-1559/native/ERC-20 transfer verifier.
- `contracts/policy_wallet/sources/verify_solana.move`: Solana native transfer and durable nonce verifier.
- `packages/core/src/ika/service.ts`: Ika SDK wrapper, shared DKG prep, presign/signature polling, centralized partial signature computation.
- `packages/core/src/policy/client.ts`: PTB builders for wallet, spend, proposal, vote, execute, pause, reserves, vault operations.
- `packages/core/src/policy/state.ts`: on-chain state readers for wallets, requests, proposals, vault balances.
- `packages/core/src/recovery/discovery.ts`: wallet discovery and address re-derivation.
- `packages/core/src/recovery/balances.ts`: recovered target-chain balance aggregation.
- `apps/web/src/App.tsx`: top-level app shell and `stINKy` branding.
- `apps/web/src/components/Dashboard.tsx`: overview, send, requests, governance, proposal details, address book.
- `apps/web/src/components/CreateWizard.tsx`: wallet creation/setup flow.
- `apps/web/src/styles.css`: visual theme and responsive UI styling.
- `README.md`: public project overview.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RECOVERY.md`: important design/security/recovery docs.
- `deployments.json`: deployment constants.

## Deployment Context

- Testnet latest package in `deployments.json` has pointed at upgraded package `0x2b36d2b823448cf4366832db0e6a6b5f18fe5567406cfc1f17ace951e1762b08`.
- Mainnet package was published from CLI on 2026-06-23.
- Mainnet package id: `0x78a1fe63d6b76fe4eb8b442e82e21238c1ee59d516c2e690bfcd5884fec329c5`.
- Mainnet registry id: `0xb1e7559aefc556f116fd06a1e4a1eda771192569d5cc031f6648f681b572f440`.
- Mainnet UpgradeCap id: `0xf67d97b4a3b8595a174a4a17a0046e380c06cb838bb070b16734950cda3be714`, owned by `0x3f4cc21cad5fc847743a00bddd8f80cbd16c6a095397fe806052acf720ef0e26`.
- Mainnet publish digest: `3itrJhp1fYWPEQNRUpiXj67aAikgLC7BP8ANQSF34mwF`.
- The repo keeps `contracts/policy_wallet/Move.toml` defaulting to testnet deps; switch `vendor/testnet` to `vendor/mainnet` before any future mainnet publish/upgrade.
- Always verify current `deployments.json` before using a deployment.

## Useful Local Commands

- Start preview server:
  - `nohup pnpm --filter @mythos/web exec vite preview --host 0.0.0.0 > /tmp/opencode/mythos-web-preview.log 2>&1 &`
- Stop preview server:
  - `pkill -f "vite preview --host 0.0.0.0"`
- Preview URLs:
  - `http://localhost:4173/`
  - `http://192.168.68.76:4173/`
- Build frontend:
  - `pnpm --filter @mythos/web build`
- Run core checks:
  - `pnpm --filter @mythos/wallet-core typecheck`
  - `pnpm --filter @mythos/wallet-core test`
- Run Move tests:
  - `pnpm test:move`

## Known Product/Security Notes

- Contract-owned shared dWallet mode is deliberate for recoverability; see `docs/SECURITY.md` for the tradeoff.
- The package upgrade policy remains a mainnet-critical decision. `docs/SECURITY.md` recommends making the package immutable after audit.
- The code is tested but not audited and not mainnet burn-in proven.
- `ACTION_WITHDRAW_RESERVES = 16` exists in Move but is not currently exposed in the TypeScript `ProposalAction` enum or web governance UI.
- Admin proposal timelock is not snapshotted. Execution uses current `wallet.timelock_admin_ms`.
- Solana verified path covers native transfers, including durable nonce, but not SPL transfers.
- EVM verified path covers native transfers and ERC-20 `transfer`, not arbitrary calldata.
- BTC verified path is P2WPKH only; taproot protocol constants exist but verified taproot spend flow is not enabled.

## Natural Next Steps

- Decide whether to expose reserve withdrawal governance (`ACTION_WITHDRAW_RESERVES`) in TypeScript/UI.
- Consider manual browser QA for the new Address Book and proposal detail UI on desktop and mobile.
- Consider code-splitting or chunk warning cleanup later; not urgent.
- Before serious mainnet value: audit, UpgradeCap policy, low-limit burn-in, recovery drill from a clean machine, and live Ika support-config checks.
