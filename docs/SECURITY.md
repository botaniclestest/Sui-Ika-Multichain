# Security Model & Threat Analysis

This document states precisely what is enforced where, what must be backed
up, and what can go wrong. Read it before holding meaningful value.

## Status: NOT AUDITED

The Move contract, the cryptographic plumbing and the chain adapters have
unit tests (36 Move tests, 15 TypeScript tests including byte-exact
cross-checks against independent implementations), but the system has **not
had a third-party audit and has not yet processed real value at scale**.

Until an audit and a supervised mainnet burn-in with small limits have
happened, treat this as production-quality *code* but not production-proven
*infrastructure*. Use testnet, or mainnet with amounts you can lose.

---

## 1. Enforcement boundaries

### Enforced on-chain (Sui Move, cannot be bypassed by any frontend)

| Guarantee | Mechanism |
|---|---|
| No signature without policy approval | The Ika `DWalletCap` lives inside the `PolicyWallet` object and can never leave. `coordinator::approve_message` is only reachable through `execute_spend`, after every check below. |
| Signer threshold | `approvals ∩ current_signers >= threshold`, recounted at execution time (votes from removed signers don't count). |
| Exact-bytes binding | The request stores the exact message bytes; `request_future_sign` locks them at creation; `approve_message` is called with those same stored bytes. A request is single-use. |
| Transaction intent (BTC) | `verify_btc.move` parses every BIP-143 preimage: SIGHASH_ALL only, scriptCode bound to the wallet's own key, hashOutputs/hashPrevouts recomputed from supplied serializations, first output = declared destination+amount, change only back to self, fee ≤ policy cap. |
| Transaction intent (EVM) | `verify_evm.move` RLP-parses the unsigned EIP-1559 tx: chain id (no cross-chain replay), recipient, value, ERC-20 `transfer` calldata, maxFee×gasLimit ≤ policy cap, empty access list, canonical RLP only. |
| Transaction intent (Solana) | `verify_solana.move` parses the legacy message: single SystemProgram transfer, wallet is sole signer and source, declared destination and lamports. Versioned messages rejected. |
| Per-tx / windowed limits | `per_tx_limit` at creation and execution; rolling `window_limit`/`window_ms` accounting recorded at execution, before signing. |
| Destination lists | Blocklist always; allowlist when enabled. |
| Timelocks | Spend timelock between threshold and execution (waived only for fast-path); admin timelock + veto window on every governance action. |
| Request expiry | Voting expires `request_expiry_ms` after creation; execution must occur within the window after the timelock. |
| Fast-path constraints | Single-approval path requires: configured limit > 0, amount within it, intent verified on-chain, zero rejections. Any rejection forces full threshold. |
| Emergency pause | Any one signer pauses instantly. Unpausing requires an admin proposal (admin threshold + timelock + veto window). |
| Signer rotation | Add/remove only via admin proposals; thresholds re-validated; registry updated. |
| Unverified payloads | Only allowed if `allow_unverified` is set for the chain, never fast-path, always full threshold + timelock. |

### Enforced by the client library (any honest client; protects honest signers)

- Re-derivation of every chain address from the Ika dWallet public output
  and comparison against the on-chain address book (`verified` flag). A
  poisoned address book is detected by every honest client.
- A byte-level mirror of all three Move verifiers runs before the approve
  button is enabled. This is defense-in-depth and the detection layer for a
  malicious package upgrade or compromised co-signer.
- Low-S normalization and signature/recovery verification before broadcast.

### Operational discipline (no code can enforce these)

- Keep signer keys on separate devices/people. The wallet is exactly as
  strong as `threshold` of your Sui keys.
- Review unverified payloads (contract calls, SPL transfers) byte-by-byte
  with an independent decoder before approving; the contract cannot parse
  them — that's why they're labeled UNVERIFIED and policy-restricted.
- Keep the wallet's IKA/SUI fee reserves topped up; an empty reserve cannot
  execute (availability, not safety).
- Set conservative limits. Limits are the blast-radius control when
  signers are compromised at or above threshold.

---

## 2. What must be backed up, what is regenerable

| Item | Sensitivity | Backup needed? |
|---|---|---|
| Your Sui signer key(s) | CRITICAL — these ARE the wallet | Yes, like any key. Hardware wallets/passkey-backed keys recommended. |
| Package id + registry id | Public constants | In `deployments.json`, on-chain, in explorers. Nothing secret. |
| dWallet user share | **None exists.** Wallets use Ika "shared" mode: the user share is public by design; authority lives entirely in the policy object. | No. |
| Frontend / localStorage / DB | Pure convenience cache | No. The recovery drill (`scripts/recover.ts`) rebuilds everything from a Sui RPC. |
| Pending request context | On-chain (messages + aux stored in the request) | No. Any signer can reassemble and broadcast a signed BTC/EVM/Solana tx from chain state alone. |

There are deliberately **no seed phrases, no encrypted blobs, no API keys**
required for custody. (RPC provider keys, if you choose to use private
endpoints, are availability-only secrets.)

### The shared-mode tradeoff (read this)

Zero-trust Ika dWallets require a user-held secret share — which is exactly
the unrecoverable, leakable localStorage material that sank previous
prototypes. This design instead uses **public-user-share ("shared") mode**:
the Ika validator threshold can technically compute a signature *if and
only if* it ignores its own protocol rule requiring a `MessageApproval`.
You are therefore trusting the Ika network's BFT threshold for
*non-signing* in addition to signing liveness. We judge this acceptable
because (a) that same threshold could censor/extort any zero-trust wallet
too, (b) it removes the single worst key-management failure mode for real
users, and (c) it is what makes the "frontend can disappear" guarantee
absolute. If you do not accept this tradeoff, the architecture supports
adding a zero-trust mode later — at the cost of a real secret to back up.

---

## 3. Threat model

| Threat | Outcome |
|---|---|
| **Malicious/compromised frontend** | Cannot move funds: it holds no keys and no caps. Worst case: it shows lies and asks signers to approve a bad request. For verified chains the contract checks the bytes against the declared intent, and every honest signer's client re-checks independently. For unverified payloads, a malicious frontend + `threshold` careless signers can lose funds — that's why `allow_unverified` is off by default. |
| **One compromised signer (below threshold)** | Can create requests (bounded by per-tx/window limits if it sneaks under fast-path; fast-path requires verified intent + zero rejections, and any honest rejection kills it), can pause the wallet (griefing, recoverable by admin unpause), cannot move funds, cannot rotate signers, cannot unpause alone. |
| **Signer collusion at/above threshold** | Funds up to per-tx/window limits per window, with the spend timelock as the reaction window for remaining honest signers to pause + rotate. At/above the admin threshold the wallet is theirs — choose signer sets so this requires real-world collusion. |
| **Lost signer key (below threshold)** | No fund loss. Remaining signers run a RemoveSigner+AddSigner proposal pair (admin threshold + timelock). |
| **Lost local cache / lost device / dead website** | Nothing is lost. See RECOVERY.md; any signer rebuilds the full wallet from a Sui RPC + their key. |
| **RPC outage / censorship** | Availability only. Use any Sui fullnode; all reads are standard RPC. Target-chain RPCs (Esplora/EVM/Solana) are also swappable. |
| **Sui reorg** | Sui has single-slot finality; executed approvals are final. |
| **Target-chain reorg** | A broadcast tx can reorg like any other tx on that chain. Window accounting on Sui still counts it (conservative). Rebroadcast is possible because messages+aux stay on-chain; for BTC the same signed tx remains valid. |
| **Ika network compromise (≥ threshold of validators)** | Can sign arbitrarily for shared-mode dWallets (see tradeoff above) and can refuse signatures (liveness) for any mode. |
| **Malicious package upgrade** | The package is published WITHOUT an UpgradeCap retained-policy decision made for you: decide at publish time. Recommended: make the package immutable (burn the UpgradeCap) once audited. Until then, the UpgradeCap holder is a super-admin — treat it like a signer key at admin threshold. |
| **Poisoned address book at setup** | A malicious creator could record wrong identities. Every client re-derives identities from the dWallet public output and flags mismatches with a SECURITY warning; signers must refuse to operate (and refuse to deposit!) until `verified=true` on every chain. |
| **Hash-scheme / cross-chain confusion** | Signing parameters (curve/algorithm/hash) are fixed per chain kind at `configure_chain` time and validated against the chain kind; requests cannot choose their own. Residual risk: a chain with `allow_unverified` shares its (curve,alg,hash) tuple with other chains using the same dWallet — an unverified payload could encode a transaction for a sibling chain, bypassing that sibling's per-chain limits (it still needs full threshold + timelock + the host chain's limits). Keep `allow_unverified` off, or accept that unverified approvals are wallet-wide approvals. |
| **Presign substitution** | Requests pin the exact presign cap object ids they consume; mismatch aborts. |
| **Fee-drain griefing** | Signer-only operations spend the wallet's IKA/SUI reserves (DKG/presigns/signing). A rogue signer can waste reserves but not funds. |
| **Solana durable-nonce/blockhash expiry** | A signed Solana transfer may expire before broadcast (blockhash ~60-90s). The request remains; re-create with a fresh blockhash if it lapses. Funds are never at risk, only convenience. |

## 4. Known limitations (v1)

- BTC: P2WPKH only (no taproot yet — protocol support exists, `Taproot`
  alg is wired in constants but not enabled in the verified path).
- Solana verified path covers native transfers only; SPL = unverified path.
- EVM verified path covers native + ERC-20 `transfer` only; arbitrary
  calldata = unverified path.
- The EVM nonce is chosen at request-creation time; two concurrent EVM
  requests on the same chain will collide on nonce (one will fail at
  broadcast; funds safe).
- `MAX_SIGNERS = 16`.
- Ed25519 (Solana) dWallets depend on the live Ika network's supported
  curves configuration; check before enabling the chain.

## 5. Mainnet checklist

- [ ] Third-party audit of `contracts/policy_wallet`.
- [ ] Decide UpgradeCap policy (recommend immutable after audit).
- [ ] Supervised burn-in: low limits, real funds, 2 weeks, all chains.
- [ ] Verify live Ika `support_config` for every (curve, alg, hash) used.
- [ ] Run the recovery drill from a clean machine for every signer.
- [ ] Confirm fee-reserve monitoring/top-up process.
