# Progress Handoff

Last updated: 2026-06-27

## Current State

- Product/site name is `stINKy Multichain Policy Wallet`.
- Current branch is `main`.
- GitHub remote is `git@github.com:botaniclestest/Sui-Ika-Multichain.git`.
- Feature work is pushed through `144d99d feat(wallet): discover token balances and verify spl sends`.
- This handoff records the subsequent testnet package upgrade, deployment metadata update, Sui Vault direct-send warning cleanup, and squid backdrop update.
- Sui CLI active environment is currently `testnet`.
- Local preview should be opened from Windows/Chrome at `http://localhost:4173/`.
- Preview process details at handoff:
  - wrapper PID `2915589`: historical prior preview process
  - Vite PID `2915603`: historical prior preview process
- Local dev server for development uses the simple Windows/WSL-friendly bind:
  - `pnpm --filter @mythos/web dev --host 0.0.0.0`
  - Open `http://localhost:5173/` in the Windows browser. Avoid transient WSL IP URLs for normal wallet testing.

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
- Cleaned up Sui Vault direct-send handling:
  - Direct-send Sui coins at the wallet object ID are intentionally not shown as vault balances.
  - The Sui Vault wallet object ID has an inline red flag: `DO NOT SEND DIRECTLY TO THIS ADDRESS. USE DEPOSIT TO VAULT FUNCTION BELOW.`
  - WAL testnet metadata fallback treats `::wal::WAL` as 9 decimals when Sui RPC returns no coin metadata.
- Added a generic Sui Vault deposit form in Overview so future SUI/WAL deposits call `vault_deposit<T>` instead of direct-transferring to the wallet object ID.
- Added uploaded `stINKy.jpg` as a full-viewport fixed squid backdrop behind the cards and cleaned up the header squid logo presentation.
- Upgraded the backdrop into an animated underwater scene:
  - The squid image gently bobs with water shimmer and bubble drift.
  - Primary actions, danger actions, tabs, wallet links, and selects trigger short green gas puffs behind the UI.
- Fixed clean-machine wallet recovery in the Vite dev app:
  - The browser was prebundling `@ika.xyz/sdk` / `@ika.xyz/ika-wasm` into Vite's optimized dependency cache.
  - The generated Ika web loader resolves `dwallet_mpc_wasm_bg.wasm` relative to `import.meta.url`; after prebundling, that relative URL pointed at the cache and the dev server returned `index.html` (`3c 21 64 6f`, `<!do`) instead of WASM.
  - `apps/web/vite.config.ts` now excludes both packages from `optimizeDeps`, so dWallet public-key extraction can load the real WASM and re-derive BTC/EVM/Solana addresses from on-chain dWallet public output again.
- Fixed the follow-on blank-page crash from Mysten's zklogin Poseidon import:
  - `@mysten/sui/dist/zklogin/poseidon.mjs` imports named exports from `poseidon-lite`, but Vite was serving raw CommonJS from the transitive package.
  - `poseidon-lite@0.2.1` is now a direct web dependency and is included in Vite dependency optimization, so the import is rewritten to Vite's CommonJS wrapper.
- Added Playwright browser testing support for the web app:
  - `@playwright/test` is a web dev dependency.
  - `apps/web/playwright.config.ts` starts/reuses Vite on port `5174` with `--host 0.0.0.0`; tests still browse via local loopback.
  - `apps/web/tests/smoke.spec.ts` catches page/module crashes and verifies the wallet shell renders.

## Sui Vault Direct-Transfer Incident

- Testnet wallet `0x7fc82c013ce85e321438a9461f795e5ec9e632ddecb33bd21cf1b45dcd1849d6` has direct address-owned coins at the wallet object ID:
  - `0.3 SUI` as `0x2::sui::SUI`.
  - `0.5 WAL` as `0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL`.
- The internal contract vault Bag for that wallet is empty, so those direct-send coins are not spendable by `execute_vault_spend<T>`.
- Root cause: the UI displayed the Sui Vault wallet object ID like an address, but the contract only treats coins as spendable after `vault_deposit<T>` receives a coin in a Sui transaction.
- Current UI behavior: direct-send balances are hidden; the Sui Vault object ID row carries the do-not-send flag.
- Future deposits should use the Overview `Deposit to Sui Vault` form with coin type, amount, and decimals.
- Do not direct-send Sui coins to the wallet object ID unless a recovery/ingest path is explicitly implemented and tested.

## Sui Vault Deposit Model

- Sui Vault deposits do not go to a normal deposit address.
- The app builds a Sui transaction that takes a coin from the connected signer wallet and calls `vault_deposit<T>(wallet, coin)`.
- The contract converts that coin into `Balance<T>` and stores it inside the `PolicyWallet.vault` Bag keyed by coin type.
- The wallet object ID is the shared policy object, not a safe recipient address for direct transfers.
- For WAL deposits, the coin type field is the inner coin type:
  - `0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL`
- Do not use the metadata wrapper type:
  - `0x2::coin::CoinMetadata<...>`

## Token-Specific Limit Plan

- Current contract limits are per chain: `fast_path_limit`, `per_tx_limit`, `window_limit`, `window_ms`, and `fee_limit` live on `ChainPolicy`.
- This is too coarse for ERC-20/SPL/Sui Vault tokens because token base units and token values differ from native-chain units.
- Preferred upgrade design: add per-asset policy overrides using dynamic fields attached to the wallet object ID, not new fields on `PolicyWallet` or `ChainPolicy`.
- Reason: dynamic fields avoid changing existing shared-object struct layouts and should be safer for package upgrades.
- Proposed Move design:
  - Add `AssetPolicyKey { chain_key: vector<u8>, asset: vector<u8> }` and `AssetPolicy { fast_path_limit, per_tx_limit, window_limit, window_ms, spent_in_window, window_started_at_ms }`.
  - Use `asset` bytes already stored in `SpendRequest`: EVM ERC-20 address bytes, Solana SPL mint bytes, Sui Vault coin type bytes, empty bytes for native if ever needed.
  - Add admin proposal action `ACTION_SET_ASSET_LIMITS` with `bytes_param = asset` and `u_params = [fast, per_tx, window_limit, window_ms]`.
  - Add optional `ACTION_REMOVE_ASSET_LIMITS` to fall back to chain-level limits.
  - Creation validation uses asset override when present; otherwise chain-level limits.
  - Fast-path checks and execution timelock use asset override when present.
  - Rolling-window accounting should be per asset override when present, otherwise chain-level.
- Proposed frontend design:
  - Governance tab section: `Token / asset limits`.
  - Pick chain, then pick a discovered asset from balances or paste asset bytes/coin type.
  - Human amount inputs use selected asset decimals.
  - Proposal cards decode asset limits with token symbol/coin type when known.
  - Overview/Send policy copy should show token-specific limits when the selected asset has an override.
- Required verification before testnet upgrade:
  - Move tests for override create/reject, fast path, timelock, per-asset rolling window, removal/fallback.
  - TypeScript tests for asset byte encoding for ERC-20, SPL mint, and Sui coin type.
  - Testnet package upgrade and `deployments.json` update.

## Transaction History Plan

- Do not implement transaction history yet.
- Best first version should be Sui-control-plane history sourced from on-chain events and request/proposal tables:
  - wallet created, signer changes, policy/proposal actions, spend request created/voted/executed, vault deposits/withdrawals.
  - link Sui transaction digests and request/proposal ids.
- Target-chain broadcast history should be layered later:
  - BTC txid from assembled/broadcast transaction.
  - EVM tx hash from signed raw transaction broadcast.
  - Solana signature from broadcast result.
- Persisting target-chain tx ids probably needs either new events/state after broadcast or local/indexed recovery from request messages; design later.

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
- After the Sui Vault direct-send warning cleanup:
  - `pnpm --filter @mythos/wallet-core typecheck`: passed.
  - `pnpm --filter @mythos/wallet-core test`: passed, 19 tests.
  - `pnpm --filter @mythos/wallet-core build && pnpm --filter @mythos/web build`: passed.
  - Live testnet query confirmed direct-send rows are not returned as Sui Vault balances.
- After the recovery fix:
  - `pnpm --filter @mythos/wallet-core test`: passed, 19 tests.
  - `pnpm --filter @mythos/web build`: passed and emitted `dist/assets/dwallet_mpc_wasm_bg-*.wasm`.
  - Local Vite dev probe at `http://127.0.0.1:5174/` confirmed the actual served Ika WASM path returns `Content-Type: application/wasm`, `Content-Length: 3439425`, and magic bytes `00 61 73 6d`.
- After the Poseidon/Playwright follow-up:
  - `pnpm --filter @mythos/web build`: passed.
  - `pnpm --filter @mythos/web test:e2e`: passed, 1 Chromium smoke test.
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
- `stINKy.jpg`: uploaded squid artwork used as the current web background.

## Useful Local Commands

- Start preview server: `setsid -f pnpm --dir apps/web exec vite preview --host 0.0.0.0 > /tmp/opencode/mythos-web-preview.log 2>&1 < /dev/null`
- Stop preview server: `pkill -f "vite preview"`
- Preview URL: `http://localhost:4173/`
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
  - Direct-send Sui object-address rows should remain hidden; warning lives next to the Sui Vault object ID.
  - EVM configured token dropdown entries when token balances exist.
  - Solana SPL token balance discovery.
  - Solana SPL spend request creation, vote, timelock, execute, and broadcast.
- Implement token-specific spend limits via governance using dynamic-field asset policies.
- Keep transaction history as a plan until token-limit work is settled.
- Decide whether to expose reserve withdrawal governance (`ACTION_WITHDRAW_RESERVES`) in TypeScript/UI.
- Before serious mainnet value: audit, UpgradeCap policy, low-limit burn-in, recovery drill from a clean machine, and live Ika support-config checks.

## Security Notes

- Contract-owned shared dWallet mode is deliberate for recoverability; see `docs/SECURITY.md` for the tradeoff.
- The code is tested but not audited and not mainnet burn-in proven.
- Mainnet tiny BTC/SOL tests have succeeded, but larger value should wait for audit/hardening.
- The UpgradeCap remains held and should be governed or made immutable before serious mainnet use.
- Arbitrary unknown EVM token discovery is not possible from plain JSON-RPC alone; current EVM token discovery is configured-token based.
