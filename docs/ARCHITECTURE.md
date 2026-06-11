# Architecture

```
                       ┌────────────────────────────────────────────┐
                       │              Sui (control plane)           │
                       │                                            │
  signers (Sui keys)──▶│  PolicyWallet (shared object)              │
                       │   ├─ DWalletCap(s)  ◀── never leave        │
                       │   ├─ signer set, thresholds, timelocks     │
                       │   ├─ ChainPolicy table (limits, lists)     │
                       │   ├─ SpendRequest table (exact bytes+aux)  │
                       │   ├─ AdminProposal table                   │
                       │   ├─ presign pools, IKA/SUI fee reserves   │
                       │   └─ native Sui vault (Bag of Balances)    │
                       │  Registry (shared) ── signer → wallet ids  │
                       │  verify_btc / verify_evm / verify_solana   │
                       └───────────────┬────────────────────────────┘
                                       │ approve_message only via execute_spend
                                       ▼
                       ┌────────────────────────────────────────────┐
                       │             Ika (signing plane)            │
                       │  shared-mode dWallets (secp256k1, ed25519) │
                       │  presign → future_sign → sign sessions     │
                       └───────────────┬────────────────────────────┘
                                       │ 64-byte signatures
                                       ▼
        ┌──────────────┬───────────────┬───────────────┬─────────────┐
        │   Bitcoin    │  EVM chains   │    Solana     │  Sui assets │
        │  P2WPKH      │  EIP-1559     │  SystemProg   │  vault      │
        │  BIP-143     │  native+ERC20 │  transfer     │  (no Ika)   │
        └──────────────┴───────────────┴───────────────┴─────────────┘
```

## Layers

| Layer | Location | Role |
|---|---|---|
| Policy contract | `contracts/policy_wallet` (Move) | Custody (`DWalletCap`), multisig, limits, timelocks, lists, pause, governance, on-chain intent verification, request/audit state, discovery registry, native Sui vault. |
| Core library | `packages/core` (TS) | Chain adapters (build/verify/assemble/broadcast), Ika service (DKG prep, presigns, centralized signatures, signature polling), PTB builders for every entry point, state readers, recovery pipeline, client-side verifier mirrors. |
| Web app | `apps/web` | Stateless UI over the core library. Wizard + dashboard. Holds nothing that matters. |
| Scripts | `scripts/` | `publish.ts`, `e2e-testnet.ts`, `recover.ts` (the recovery drill). |

## Key design decisions and their tradeoffs

1. **Contract-owned dWallets in shared mode.** The contract performs DKG
   itself (`request_dwallet_dkg_with_public_user_secret_key_share`) and
   keeps the cap. No user share exists; recovery needs only a Sui key.
   Tradeoff: trust in the Ika validator threshold extends from liveness to
   non-signing (documented in SECURITY.md). The alternative (zero-trust
   shares in browser storage) repeatedly proved to be the weakest link in
   the predecessor prototypes.

2. **On-chain intent verification.** Move parsers for BIP-143/RLP/Solana
   messages close the worst gap of the earlier designs, where the contract
   signed whatever bytes the request creator claimed matched the declared
   amount/destination. Verified intents earn the fast path; anything
   unparseable is allowed only under explicit policy and maximum friction.

3. **One secp256k1 dWallet shared by BTC + EVM; ed25519 for Solana.**
   Fewer DKGs, fewer fee reserves, simpler recovery. Signing parameters are
   pinned per chain kind to prevent hash-scheme confusion; the residual
   cross-chain surface of unverified payloads is documented.

4. **Sui assets live in a vault inside the wallet object**, not behind a
   dWallet: native execution gives them the strongest guarantees for free
   and removes Ika fees/latency for Sui transfers.

5. **Requests store everything needed to finish the job** (exact messages
   plus BTC aux serializations), so executing and broadcasting can be done
   by any signer on any machine — including after total frontend loss.

6. **Discovery is triple-redundant** (owned caps, registry table, events)
   and the address book is a verifiable cache, never a source of truth.

## Chain adapter contract

A new chain needs:
1. a `ChainKind` (or `Generic` + unverified path to start),
2. an adapter in `packages/core/src/chains/` implementing: derive address
   from dWallet pubkey, build exact sign-bytes for a transfer, client
   intent check, assemble signed tx, broadcast,
3. optionally a Move verifier to earn verified-intent status,
4. a `ChainDescriptor` entry.

Nothing else changes: policy, voting, custody, recovery are chain-agnostic.
