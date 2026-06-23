# Progress Handoff

Last updated: 2026-06-23

## Current State

- Product/site name is `stINKy Multichain Policy Wallet`.
- Current branch is `main`.
- GitHub remote is `git@github.com:botaniclestest/Sui-Ika-Multichain.git`.
- Feature work is pushed through `144d99d feat(wallet): discover token balances and verify spl sends`.
- This handoff records the subsequent testnet package upgrade, deployment metadata update, and Sui Vault direct-transfer diagnostics fix.
- Sui CLI active environment is currently `testnet`.
- Local preview is running from rebuilt output at `http://localhost:4173/` and `http://192.168.68.76:4173/`.
- Preview process details at handoff:
  - wrapper PID `2907361`: `pnpm --dir apps/web exec vite preview --host 0.0.0.0`
  - Vite PID `2907385`: `vite preview --host 0.0.0.0`

## What This Project Is

- A Sui Move policy wallet using Ika dWallets/MPC for native BTC, EVM, and Solana signing.
- Sui is the control plane: the `PolicyWallet` shared object owns Ika `DWalletCap`s and stores policy, requests, proposals, address book, presign pools, and fee reserves.
- Ika is the signing plane: dWallets produce target-chain signatures only after the Move contract emits a valid `MessageApproval`.
- Sui assets use a native vault inside the wallet object and do not use Ika signing.
- Recovery is intended to be fully on-chain: any signer can rebuild wallets, addresses, policy, requests, proposals, vault balances, and target-chain balances from Sui/RPC state.

## Completed In This Session

- Added lightweight green gas background styling and pushed it:
  - `eb7f984 feat(web): add lightweight green gas background`
- Added token discovery, dropdown-driven sends, and verified Solana SPL support and pushed it:
  - `144d99d feat(wallet): discover token balances and verify spl sends`
- Replaced manual token address/decimals Send UX with chain asset selection from recovered balances.
- Added Overview and Send token/vault balance display using `ChainBalanceRow`.
- Added Sui Vault coin metadata lookup for labels/decimals.
- Added configured EVM ERC-20 balance discovery via `balanceOf`.
- Added Solana SPL balance discovery via `getParsedTokenAccountsByOwner`.
- Added Solana SPL durable nonce transaction builder with idempotent ATA creation and `TransferChecked`.
- Added client-side SPL intent checks in `packages/core/src/verify/intent.ts`.
- Added Move SPL verifier support in `contracts/policy_wallet/sources/verify_solana.move`.
- Added TypeScript and Move tests for SPL transfer verification.
- Upgraded the testnet Move package so SPL verifier support is live on testnet.
- Updated local deployment metadata to point the web app at the upgraded testnet package.
- Rebuilt and restarted the local preview server.
- Fixed Sui Vault balance confusion after direct transfers to the wallet object ID:
  - `packages/core/src/recovery/balances.ts` now reads `getAllBalances({ owner: walletId })` in addition to the internal vault Bag.
  - Direct-send Sui coins are shown as red, non-spendable `sui-address` rows instead of being silently hidden.
  - The Send asset dropdown still only includes spendable vault/deposited assets.
  - WAL testnet metadata fallback treats `::wal::WAL` as 9 decimals when Sui RPC returns no coin metadata.
- Added a generic Sui Vault deposit form in Overview so future SUI/WAL deposits call `vault_deposit<T>` instead of direct-transferring to the wallet object ID.

## Sui Vault Direct-Transfer Incident

- Testnet wallet `0x7fc82c013ce85e321438a9461f795e5ec9e632ddecb33bd21cf1b45dcd1849d6` has direct address-owned coins at the wallet object ID:
  - `0.3 SUI` as `0x2::sui::SUI`.
  - `0.5 WAL` as `0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL`.
- The internal contract vault Bag for that wallet is empty, so those direct-send coins are not spendable by `execute_vault_spend<T>`.
- Root cause: the UI displayed the Sui Vault wallet object ID like an address, but the contract only treats coins as spendable after `vault_deposit<T>` receives a coin in a Sui transaction.
- Current UI behavior: direct-send balances are visible in Overview with the warning `sent to wallet object address, not deposited into the spendable vault`.
- Future deposits should use the Overview `Deposit to Sui Vault` form with coin type, amount, and decimals.
- Do not direct-send Sui coins to the wallet object ID unless a recovery/ingest path is explicitly implemented and tested.

## Testnet Deployment

- Original testnet package id: `0x7ff6377aca6185c4abe903fd88d90f0a540001b55698c6d513d8e093ea774fc2`.
- Testnet registry id: `0xd04d558c2ea37f4fda11e184df83d035634f8c9c42d47860c154f166eab24eff`.
- Testnet UpgradeCap id: `0xfe24143f475bf1772d1b1ce54de9650bfecbd2653c6d6bac89c3b50d3489e0d6`.
- Previous latest testnet package id: `0x2b36d2b823448cf4366832db0e6a6b5f18fe5567406cfc1f17ace951e1762b08`.
- Current latest testnet package id: `0x2e3b49e1be063eab890d57e5b0f783aefc9be6153ca2007b8595417a8ea70557`.
- Current latest testnet upgrade digest: `35hFfkQo1bUGYhyN1QhkNXfjqcuecQvT64USriNtGEcZ`.
- Testnet package version in `Published.toml`: `4`.
- `deployments.json` now uses `latestPackageId` for testnet app calls.
- Testnet gas after upgrade was about `8.80` SUI across two gas coins.

## Mainnet Deployment

- Mainnet package id: `0x78a1fe63d6b76fe4eb8b442e82e21238c1ee59d516c2e690bfcd5884fec329c5`.
- Mainnet registry id: `0xb1e7559aefc556f116fd06a1e4a1eda771192569d5cc031f6648f681b572f440`.
- Mainnet UpgradeCap id: `0xf67d97b4a3b8595a174a4a17a0046e380c06cb838bb070b16734950cda3be714`.
- Mainnet publish digest: `3itrJhp1fYWPEQNRUpiXj67aAikgLC7BP8ANQSF34mwF`.
- Mainnet has not been upgraded with the latest SPL verifier/token discovery contract changes.
- Keep `contracts/policy_wallet/Move.toml` defaulting to testnet deps. Switch `vendor/testnet` to `vendor/mainnet` only before a future mainnet publish/upgrade.

## Verification Run

- `pnpm --filter @mythos/wallet-core typecheck`: passed.
- `pnpm --filter @mythos/wallet-core test`: passed, 19 tests.
- `pnpm --filter @mythos/wallet-core build`: passed.
- `pnpm test:move`: passed, 46 tests.
- `pnpm --filter @mythos/web build`: passed after deployment metadata update.
- After the Sui Vault direct-transfer diagnostics fix:
  - `pnpm --filter @mythos/wallet-core typecheck`: passed.
  - `pnpm --filter @mythos/wallet-core test`: passed, 19 tests.
  - `pnpm --filter @mythos/wallet-core build && pnpm --filter @mythos/web build`: passed.
  - Live testnet query confirmed the direct-send rows show `0.3 SUI` and `0.5 WAL` with non-spendable status.
- `git diff --check origin/main...HEAD`: passed before pushing feature commits.
- Strict outgoing diff credential-format scan returned no matches before pushing feature commits.
- Testnet upgrade dry-run first failed because `Published.toml` still pointed at the original package; aligning testnet `published-at` to the previous latest package fixed the package mismatch.
- Testnet upgrade dry-run then passed before executing the real upgrade.

Known non-blocking warnings:

- Move warns about deprecated `vector::empty` usage in existing code/tests.
- Vite warns that `packages/core/dist/index.js` is both dynamically and statically imported.
- Vite warns that some chunks are larger than 500 kB after minification.

## Key Files

- `apps/web/src/components/Dashboard.tsx`: Overview, Send, Requests, Governance, asset dropdown, balance display.
- `apps/web/src/hooks.ts`: spend creation flow, including native/SPL Solana branching.
- `apps/web/src/styles.css`: pink/green theme and lightweight gas background.
- `apps/web/src/assets/stinky-squid.svg`: current squid logo asset.
- `packages/core/src/config.ts`: target-chain RPCs and configured EVM token registry.
- `packages/core/src/recovery/balances.ts`: native, token, Solana SPL, and Sui Vault asset discovery.
- `packages/core/src/chains/evm.ts`: native EVM balance and ERC-20 `balanceOf` helpers.
- `packages/core/src/chains/solana.ts`: Solana native/SPL balances, nonce helpers, SPL durable transfer builder.
- `packages/core/src/verify/intent.ts`: client-side BTC/EVM/Solana intent verification, including SPL checks.
- `contracts/policy_wallet/sources/policy_wallet.move`: policy wallet dispatch into target-chain verifiers.
- `contracts/policy_wallet/sources/verify_solana.move`: native SOL and SPL `TransferChecked` verifier.
- `contracts/policy_wallet/tests/verify_tests.move`: Move verifier tests, including SPL cases.
- `deployments.json`: deployment constants consumed by the web app.
- `contracts/policy_wallet/Published.toml`: Move publication metadata for CLI upgrades.

## Useful Local Commands

- Start preview server: `setsid -f pnpm --dir apps/web exec vite preview --host 0.0.0.0 > /tmp/opencode/mythos-web-preview.log 2>&1 < /dev/null`
- Stop preview server: `pkill -f "vite preview"`
- Preview URLs: `http://localhost:4173/`, `http://192.168.68.76:4173/`
- Build frontend: `pnpm --filter @mythos/web build`
- Run core checks: `pnpm --filter @mythos/wallet-core typecheck`, `pnpm --filter @mythos/wallet-core test`, `pnpm --filter @mythos/wallet-core build`
- Run Move tests: `pnpm test:move`
- Check Sui environment: `sui client active-env`
- Switch Sui environment to testnet: `sui client switch --env testnet`

## Remaining Work

- Hard refresh `http://localhost:4173/` before browser QA.
- Test on testnet:
  - Sui Vault asset dropdown with SUI/IKA vault balances.
  - Sui Vault deposit form for SUI and WAL from the connected signer wallet.
  - Direct-send Sui object-address rows should appear in Overview but not Send.
  - EVM configured token dropdown entries when token balances exist.
  - Solana SPL token balance discovery.
  - Solana SPL spend request creation, vote, timelock, execute, and broadcast.
- Decide whether to expose reserve withdrawal governance (`ACTION_WITHDRAW_RESERVES`) in TypeScript/UI.
- Before serious mainnet value: audit, UpgradeCap policy, low-limit burn-in, recovery drill from a clean machine, and live Ika support-config checks.

## Security Notes

- Contract-owned shared dWallet mode is deliberate for recoverability; see `docs/SECURITY.md` for the tradeoff.
- The code is tested but not audited and not mainnet burn-in proven.
- Mainnet tiny BTC/SOL tests have succeeded, but larger value should wait for audit/hardening.
- The UpgradeCap remains held and should be governed or made immutable before serious mainnet use.
- Arbitrary unknown EVM token discovery is not possible from plain JSON-RPC alone; current EVM token discovery is configured-token based.
