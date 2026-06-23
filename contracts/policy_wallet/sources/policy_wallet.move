// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// # Mythos Policy Wallet - core module
///
/// A persistent, recoverable, policy-controlled multichain wallet.
///
/// ## Architecture
/// * **Sui is the control plane.** This shared object holds the Ika
///   `DWalletCap`s. Once a cap is inside the wallet it can never leave, and
///   the ONLY code path that can produce an Ika `MessageApproval` (and hence
///   a signature on any chain) is `execute_spend`, which runs after the full
///   policy gauntlet: signer threshold, per-chain limits, allow/block lists,
///   rolling spend windows, timelocks, expiry and pause checks.
/// * **Ika is the signing plane.** dWallets are created BY this contract in
///   "shared" (public user share) mode: there is no user-side secret to back
///   up or leak. Security reduces to (a) the Sui signer set and this policy,
///   and (b) the Ika network's enforcement of MessageApprovals.
/// * **Recovery is on-chain.** The wallet object, its requests, its policy
///   config, its per-chain address book and the registry are all durable Sui
///   state. Any signer can rebuild the entire wallet view from a fresh
///   browser with only a Sui RPC endpoint.
///
/// ## Intent binding
/// Every spend request stores the EXACT bytes Ika will sign. For BTC, EVM
/// and Solana native transfers the contract additionally parses those bytes
/// on-chain and proves they pay the declared amount to the declared
/// destination (see `verify_btc`, `verify_evm`, `verify_solana`). Payloads
/// the contract cannot parse (contract calls, SPL transfers, future chains)
/// take the "unverified" path which always requires the full threshold plus
/// the spend timelock, and must be explicitly enabled per chain.
#[allow(deprecated_usage)]
module policy_wallet::policy_wallet;

use ika::ika::IKA;
use ika_dwallet_2pc_mpc::coordinator::DWalletCoordinator;
use ika_dwallet_2pc_mpc::coordinator_inner::{
    DWalletCap,
    UnverifiedPresignCap,
    UnverifiedPartialUserSignatureCap,
};
use ika_dwallet_2pc_mpc::sessions_manager::SessionIdentifier;
use policy_wallet::events;
use policy_wallet::registry::Registry;
use policy_wallet::verify_btc;
use policy_wallet::verify_evm;
use policy_wallet::verify_solana;
use std::type_name;
use sui::address as sui_address;
use sui::bag::{Self, Bag};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};

// === Errors ===

const ENotSigner: u64 = 0;
const EBadThreshold: u64 = 1;
const ETooFewSigners: u64 = 2;
const EDuplicateSigner: u64 = 3;
const EPaused: u64 = 4;
const ENotPaused: u64 = 5;
const ESetupNotComplete: u64 = 6;
const ESetupAlreadyComplete: u64 = 7;
const ENotCreator: u64 = 8;
const EChainUnknown: u64 = 9;
const EChainDisabled: u64 = 10;
const EChainExists: u64 = 11;
const EBadChainConfig: u64 = 12;
const ERequestNotFound: u64 = 13;
const ERequestNotPending: u64 = 14;
const EAlreadyVoted: u64 = 15;
const ERequestExpired: u64 = 16;
const EThresholdNotReached: u64 = 17;
const ETimelockActive: u64 = 18;
const EAmountZero: u64 = 19;
const EOverPerTxLimit: u64 = 20;
const EOverWindowLimit: u64 = 21;
const EDestinationBlocked: u64 = 22;
const EDestinationNotAllowed: u64 = 23;
const EUnverifiedNotAllowed: u64 = 24;
const EMessageCountMismatch: u64 = 25;
const ENoMessages: u64 = 26;
const ENoPresignAvailable: u64 = 27;
const EPresignMismatch: u64 = 28;
const EPresignNotReady: u64 = 29;
const EDWalletMissing: u64 = 30;
const EDWalletExists: u64 = 31;
const EAddressBookMissing: u64 = 32;
const EProposalNotFound: u64 = 33;
const EProposalNotPending: u64 = 34;
const EBadProposal: u64 = 35;
const ENotVaultChain: u64 = 36;
const EVaultWrongAsset: u64 = 37;
const EVaultInsufficient: u64 = 38;
const EVaultAmountTooLarge: u64 = 39;
const EBadDestination: u64 = 41;
const ENotVaultKind: u64 = 42;
const EExpiryZero: u64 = 43;
const ECreatorOnly: u64 = 44;
const ESignerLimit: u64 = 45;

// === Constants ===

const MAX_SIGNERS: u64 = 16;

// Chain kinds
const KIND_BTC: u8 = 0;
const KIND_EVM: u8 = 1;
const KIND_SOLANA: u8 = 2;
const KIND_SUI_VAULT: u8 = 3;
const KIND_GENERIC: u8 = 4;

// Curves (Ika numbering)
const CURVE_SECP256K1: u32 = 0;
const CURVE_ED25519: u32 = 2;

// Signature algorithms (per-curve Ika numbering)
const ALG_ECDSA: u32 = 0;
// Hash schemes (per curve+algorithm Ika numbering)
const HASH_KECCAK256: u32 = 0;
const HASH_DOUBLE_SHA256: u32 = 2;
const HASH_SHA512: u32 = 0;

// Request status
const STATUS_PENDING: u8 = 0;
const STATUS_EXECUTED: u8 = 1;
const STATUS_REJECTED: u8 = 2;
const STATUS_CANCELLED: u8 = 3;
const STATUS_EXPIRED: u8 = 4;

// Admin proposal actions
const ACTION_ADD_SIGNER: u8 = 1;
const ACTION_REMOVE_SIGNER: u8 = 2;
const ACTION_SET_THRESHOLDS: u8 = 3;
const ACTION_SET_TIMELOCKS: u8 = 4;
const ACTION_SET_EXPIRY: u8 = 5;
const ACTION_SET_CHAIN_LIMITS: u8 = 6;
const ACTION_ALLOWLIST_ADD: u8 = 7;
const ACTION_ALLOWLIST_REMOVE: u8 = 8;
const ACTION_BLOCKLIST_ADD: u8 = 9;
const ACTION_BLOCKLIST_REMOVE: u8 = 10;
const ACTION_UNPAUSE: u8 = 11;
const ACTION_SET_ADDRESS_BOOK: u8 = 12;
const ACTION_SET_CHAIN_ENABLED: u8 = 13;
const ACTION_SET_ALLOWLIST_ENABLED: u8 = 14;
const ACTION_SET_ALLOW_UNVERIFIED: u8 = 15;
/// Withdraw fee reserves (IKA/SUI) to a recipient. Admin-gated escape
/// hatch so reserves are never permanently stranded in the wallet.
const ACTION_WITHDRAW_RESERVES: u8 = 16;

const U64_MAX: u128 = 18_446_744_073_709_551_615;

// === Structs ===

/// The wallet itself. Shared object; the single source of truth.
public struct PolicyWallet has key {
    id: UID,
    // --- governance ---
    creator: address,
    signers: vector<address>,
    threshold: u64,
    admin_threshold: u64,
    timelock_spend_ms: u64,
    timelock_admin_ms: u64,
    request_expiry_ms: u64,
    paused: bool,
    setup_complete: bool,
    // --- Ika signing plane ---
    dwallets: Table<u32, DWalletEntry>,
    presigns: Table<PresignKey, vector<UnverifiedPresignCap>>,
    network_encryption_key_id: ID,
    ika_balance: Balance<IKA>,
    sui_balance: Balance<SUI>,
    // --- policy ---
    chains: Table<vector<u8>, ChainPolicy>,
    address_book: Table<vector<u8>, vector<u8>>,
    // --- requests ---
    requests: Table<u64, SpendRequest>,
    request_counter: u64,
    proposals: Table<u64, AdminProposal>,
    proposal_counter: u64,
    // --- native Sui vault ---
    vault: Bag,
}

/// Discovery aid transferred to every signer. NOT used for authorization
/// (authorization is sender-address membership, which survives cap loss and
/// keeps signer rotation simple); it exists so `getOwnedObjects` finds your
/// wallets instantly from a fresh client.
public struct SignerCap has key {
    id: UID,
    wallet_id: ID,
}

public struct DWalletEntry has store {
    cap: DWalletCap,
    dwallet_id: ID,
}

public struct PresignKey has copy, drop, store {
    curve: u32,
    signature_algorithm: u32,
}

public struct ChainPolicy has store {
    kind: u8,
    enabled: bool,
    /// EVM chain id (kind == KIND_EVM only; 0 otherwise).
    evm_chain_id: u128,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    /// Amounts at or below this need only 1 approval and no timelock.
    /// 0 disables the fast path.
    fast_path_limit: u128,
    /// Hard cap per request, in chain base units.
    per_tx_limit: u128,
    /// Rolling window cap.
    window_limit: u128,
    window_ms: u64,
    spent_in_window: u128,
    window_started_at_ms: u64,
    /// Max network fee the wallet may pay (sats for BTC, wei of gas for EVM).
    fee_limit: u128,
    allowlist_enabled: bool,
    allowlist: VecSet<vector<u8>>,
    blocklist: VecSet<vector<u8>>,
    /// Whether payloads the contract cannot parse may be signed for this
    /// chain (always at full threshold + timelock).
    allow_unverified: bool,
}

public struct SpendRequest has store {
    id: u64,
    creator: address,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    verified_intent: bool,
    messages: vector<vector<u8>>,
    /// Chain-specific reconstruction context (BTC: [outputs, prevouts]).
    /// Stored so ANY signer can reassemble and broadcast the final
    /// transaction from on-chain data alone.
    aux: vector<vector<u8>>,
    partial_sig_caps: vector<UnverifiedPartialUserSignatureCap>,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    approvals: VecSet<address>,
    rejections: VecSet<address>,
    created_at_ms: u64,
    /// 0 until the approval threshold is met.
    threshold_reached_at_ms: u64,
    status: u8,
    sign_ids: vector<ID>,
}

public struct AdminProposal has store {
    id: u64,
    creator: address,
    action: u8,
    chain_key: vector<u8>,
    addr_param: Option<address>,
    bytes_param: vector<u8>,
    u_params: vector<u128>,
    bool_param: bool,
    approvals: VecSet<address>,
    rejections: VecSet<address>,
    created_at_ms: u64,
    threshold_reached_at_ms: u64,
    status: u8,
}

// === Wallet creation ===

/// Creates a new policy wallet. The contract itself performs the Ika DKG in
/// shared (public-user-share) mode and takes permanent custody of the
/// resulting `DWalletCap`: no key material ever exists outside the Ika
/// network and this object.
public fun create_wallet(
    registry: &mut Registry,
    coordinator: &mut DWalletCoordinator,
    signers: vector<address>,
    threshold: u64,
    admin_threshold: u64,
    timelock_spend_ms: u64,
    timelock_admin_ms: u64,
    request_expiry_ms: u64,
    network_encryption_key_id: ID,
    centralized_public_key_share_and_proof: vector<u8>,
    user_public_output: vector<u8>,
    public_user_secret_key_share: vector<u8>,
    session_identifier: vector<u8>,
    mut ika_coin: Coin<IKA>,
    mut sui_coin: Coin<SUI>,
    ctx: &mut TxContext,
) {
    let n = signers.length();
    assert!(n >= 1 && n <= MAX_SIGNERS, ETooFewSigners);
    assert!(threshold >= 1 && threshold <= n, EBadThreshold);
    assert!(admin_threshold >= threshold && admin_threshold <= n, EBadThreshold);
    assert!(request_expiry_ms > 0, EExpiryZero);
    let unique = vec_set::from_keys(signers);
    assert!(unique.length() == n, EDuplicateSigner);

    let registered_session = coordinator.register_session_identifier(session_identifier, ctx);

    let (dwallet_cap, _) = coordinator.request_dwallet_dkg_with_public_user_secret_key_share(
        network_encryption_key_id,
        CURVE_SECP256K1,
        centralized_public_key_share_and_proof,
        user_public_output,
        public_user_secret_key_share,
        option::none(),
        registered_session,
        &mut ika_coin,
        &mut sui_coin,
        ctx,
    );
    let dwallet_id = dwallet_cap.dwallet_id();
    let dwallet_cap_id = object::id(&dwallet_cap);

    let mut wallet = PolicyWallet {
        id: object::new(ctx),
        creator: ctx.sender(),
        signers,
        threshold,
        admin_threshold,
        timelock_spend_ms,
        timelock_admin_ms,
        request_expiry_ms,
        paused: false,
        setup_complete: false,
        dwallets: table::new(ctx),
        presigns: table::new(ctx),
        network_encryption_key_id,
        ika_balance: ika_coin.into_balance(),
        sui_balance: sui_coin.into_balance(),
        chains: table::new(ctx),
        address_book: table::new(ctx),
        requests: table::new(ctx),
        request_counter: 0,
        proposals: table::new(ctx),
        proposal_counter: 0,
        vault: bag::new(ctx),
    };

    wallet.dwallets.add(CURVE_SECP256K1, DWalletEntry { cap: dwallet_cap, dwallet_id });

    let wallet_id = object::id(&wallet);
    registry.register_wallet();
    let mut i = 0;
    while (i < wallet.signers.length()) {
        let signer_addr = wallet.signers[i];
        registry.add_signer(signer_addr, wallet_id);
        transfer::transfer(SignerCap { id: object::new(ctx), wallet_id }, signer_addr);
        i = i + 1;
    };

    events::wallet_created(
        wallet_id,
        ctx.sender(),
        wallet.signers,
        threshold,
        admin_threshold,
        dwallet_id,
        dwallet_cap_id,
    );

    transfer::share_object(wallet);
}

/// Adds a dWallet on another curve (e.g. ed25519 for Solana) under the same
/// policy. Signer-only; the new capability is policy-gated like the first.
public fun add_dwallet(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    curve: u32,
    centralized_public_key_share_and_proof: vector<u8>,
    user_public_output: vector<u8>,
    public_user_secret_key_share: vector<u8>,
    session_identifier: vector<u8>,
    ctx: &mut TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(!wallet.dwallets.contains(curve), EDWalletExists);

    let registered_session = coordinator.register_session_identifier(session_identifier, ctx);
    let (mut pay_ika, mut pay_sui) = withdraw_payments(wallet, ctx);

    let (dwallet_cap, _) = coordinator.request_dwallet_dkg_with_public_user_secret_key_share(
        wallet.network_encryption_key_id,
        curve,
        centralized_public_key_share_and_proof,
        user_public_output,
        public_user_secret_key_share,
        option::none(),
        registered_session,
        &mut pay_ika,
        &mut pay_sui,
        ctx,
    );
    return_payments(wallet, pay_ika, pay_sui);

    let dwallet_id = dwallet_cap.dwallet_id();
    let dwallet_cap_id = object::id(&dwallet_cap);
    wallet.dwallets.add(curve, DWalletEntry { cap: dwallet_cap, dwallet_id });
    events::dwallet_added(object::id(wallet), curve, dwallet_id, dwallet_cap_id);
}

// === Setup phase (creator-only, before finalize_setup) ===

/// Configures a chain. During setup only the creator may call this; after
/// `finalize_setup` chain changes go through admin proposals.
public fun configure_chain(
    wallet: &mut PolicyWallet,
    chain_key: vector<u8>,
    kind: u8,
    evm_chain_id: u128,
    fast_path_limit: u128,
    per_tx_limit: u128,
    window_limit: u128,
    window_ms: u64,
    fee_limit: u128,
    allowlist_enabled: bool,
    allow_unverified: bool,
    ctx: &TxContext,
) {
    assert!(!wallet.setup_complete, ESetupAlreadyComplete);
    assert!(ctx.sender() == wallet.creator, ENotCreator);
    assert!(!wallet.chains.contains(chain_key), EChainExists);
    assert!(kind <= KIND_GENERIC, EBadChainConfig);
    assert!(per_tx_limit > 0, EBadChainConfig);
    assert!(fast_path_limit <= per_tx_limit, EBadChainConfig);
    assert!(window_limit >= per_tx_limit, EBadChainConfig);
    assert!(window_ms > 0, EBadChainConfig);

    // Signing parameters are fixed per chain kind; this prevents
    // hash-scheme/curve confusion attacks at request time.
    let (curve, signature_algorithm, hash_scheme) = if (kind == KIND_BTC) {
        (CURVE_SECP256K1, ALG_ECDSA, HASH_DOUBLE_SHA256)
    } else if (kind == KIND_EVM) {
        assert!(evm_chain_id > 0, EBadChainConfig);
        (CURVE_SECP256K1, ALG_ECDSA, HASH_KECCAK256)
    } else if (kind == KIND_SOLANA) {
        (CURVE_ED25519, ALG_ECDSA /* EdDSA = 0 on ed25519 */, HASH_SHA512)
    } else if (kind == KIND_SUI_VAULT) {
        (0, 0, 0)
    } else {
        // Generic chains are always unverified-only.
        assert!(allow_unverified, EBadChainConfig);
        (CURVE_SECP256K1, ALG_ECDSA, HASH_DOUBLE_SHA256)
    };

    if (kind != KIND_SUI_VAULT) {
        assert!(wallet.dwallets.contains(curve), EDWalletMissing);
    };

    wallet.chains.add(chain_key, ChainPolicy {
        kind,
        enabled: true,
        evm_chain_id,
        curve,
        signature_algorithm,
        hash_scheme,
        fast_path_limit,
        per_tx_limit,
        window_limit,
        window_ms,
        spent_in_window: 0,
        window_started_at_ms: 0,
        fee_limit,
        allowlist_enabled,
        allowlist: vec_set::empty(),
        blocklist: vec_set::empty(),
        allow_unverified,
    });

    events::chain_configured(object::id(wallet), chain_key, kind, true);
}

/// Records the wallet's own identity on a target chain (BTC scriptPubKey,
/// EVM address, Solana pubkey). Used by the BTC/Solana verifiers ("change
/// must return to self", "source must be self") and as the durable address
/// manifest for recovery. Clients MUST independently recompute these from
/// the dWallet public output and refuse to operate on a mismatch.
public fun record_address(
    wallet: &mut PolicyWallet,
    chain_key: vector<u8>,
    identity: vector<u8>,
    ctx: &TxContext,
) {
    assert!(!wallet.setup_complete, ESetupAlreadyComplete);
    assert!(ctx.sender() == wallet.creator, ENotCreator);
    if (wallet.address_book.contains(chain_key)) {
        *wallet.address_book.borrow_mut(chain_key) = identity;
    } else {
        wallet.address_book.add(chain_key, identity);
    };
    events::address_recorded(object::id(wallet), chain_key, identity);
}

/// Adds an initial allowlist entry during setup.
public fun setup_allowlist_add(
    wallet: &mut PolicyWallet,
    chain_key: vector<u8>,
    destination: vector<u8>,
    ctx: &TxContext,
) {
    assert!(!wallet.setup_complete, ESetupAlreadyComplete);
    assert!(ctx.sender() == wallet.creator, ENotCreator);
    assert!(wallet.chains.contains(chain_key), EChainUnknown);
    let chain = wallet.chains.borrow_mut(chain_key);
    if (!chain.allowlist.contains(&destination)) {
        chain.allowlist.insert(destination);
    };
}

/// Locks setup. From here on, every policy change requires an admin
/// proposal with the admin threshold, timelock and veto window.
public fun finalize_setup(wallet: &mut PolicyWallet, ctx: &TxContext) {
    assert!(!wallet.setup_complete, ESetupAlreadyComplete);
    assert!(ctx.sender() == wallet.creator, ENotCreator);
    wallet.setup_complete = true;
    events::setup_finalized(object::id(wallet));
}

// === Funding & presigns ===

/// Tops up the wallet's protocol-fee balances. Anyone may fund.
public fun deposit_balances(
    wallet: &mut PolicyWallet,
    ika_coin: Coin<IKA>,
    sui_coin: Coin<SUI>,
) {
    let ika_amount = ika_coin.value();
    let sui_amount = sui_coin.value();
    wallet.ika_balance.join(ika_coin.into_balance());
    wallet.sui_balance.join(sui_coin.into_balance());
    events::balance_deposited(object::id(wallet), ika_amount, sui_amount);
}

/// Requests a presign and stores its capability in the wallet's pool.
/// DEPRECATED in favor of `add_presign_v2`: this version guesses
/// per-dWallet vs global presigns from the curve/algorithm, but whether a
/// (curve, algorithm) pair uses global presigns is live network
/// configuration. Kept for upgrade compatibility.
public fun add_presign(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    curve: u32,
    signature_algorithm: u32,
    ctx: &mut TxContext,
) {
    let is_ecdsa = (curve == CURVE_SECP256K1 || curve == 1) && signature_algorithm == ALG_ECDSA;
    do_add_presign(wallet, coordinator, curve, signature_algorithm, !is_ecdsa, ctx);
}

/// Requests a presign and stores its capability in the wallet's pool.
/// `global` must match the Ika network's presign configuration for the
/// (curve, signature_algorithm) pair (the coordinator aborts otherwise, so
/// a wrong value can never corrupt state). Fees are paid from the wallet's
/// balances. Signer-only.
public fun add_presign_v2(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    curve: u32,
    signature_algorithm: u32,
    global: bool,
    ctx: &mut TxContext,
) {
    do_add_presign(wallet, coordinator, curve, signature_algorithm, global, ctx);
}

fun do_add_presign(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    curve: u32,
    signature_algorithm: u32,
    global: bool,
    ctx: &mut TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(wallet.dwallets.contains(curve), EDWalletMissing);

    let (mut pay_ika, mut pay_sui) = withdraw_payments(wallet, ctx);
    let session = fresh_session(coordinator, ctx);

    let cap = if (global) {
        coordinator.request_global_presign(
            wallet.network_encryption_key_id,
            curve,
            signature_algorithm,
            session,
            &mut pay_ika,
            &mut pay_sui,
            ctx,
        )
    } else {
        let dwallet_id = wallet.dwallets.borrow(curve).dwallet_id;
        coordinator.request_presign(
            dwallet_id,
            signature_algorithm,
            session,
            &mut pay_ika,
            &mut pay_sui,
            ctx,
        )
    };
    return_payments(wallet, pay_ika, pay_sui);

    let cap_id = object::id(&cap);
    let key = PresignKey { curve, signature_algorithm };
    if (!wallet.presigns.contains(key)) {
        wallet.presigns.add(key, vector::empty());
    };
    wallet.presigns.borrow_mut(key).push_back(cap);
    events::presign_added(object::id(wallet), curve, signature_algorithm, cap_id);
}

// === Native Sui vault ===

/// Deposits any Sui coin type into the wallet's vault. Anyone may deposit.
public fun vault_deposit<T>(wallet: &mut PolicyWallet, deposit: Coin<T>) {
    let key = type_name::get<T>();
    let amount = deposit.value();
    if (wallet.vault.contains(key)) {
        let bal: &mut Balance<T> = wallet.vault.borrow_mut(key);
        bal.join(deposit.into_balance());
    } else {
        wallet.vault.add(key, deposit.into_balance());
    };
    events::vault_deposit(
        object::id(wallet),
        type_name::get<T>().into_string().into_bytes(),
        amount,
    );
}

// === Spend requests ===

/// Creates a spend request. The exact bytes Ika will sign are stored
/// on-chain and (for verifiable chains) parsed and proven to match the
/// declared destination/amount. For each message a presign is consumed and
/// an Ika future-sign capability is locked into the request; the network
/// can complete the signature ONLY after `execute_spend` passes the policy.
///
/// `expected_presign_cap_ids` pins which presigns this request consumes
/// (last-in-first-out from the pool) so the centralized signatures the
/// client computed cannot be silently paired with different presigns.
///
/// `aux` is chain-specific context: for BTC `[outputs_bytes, prevouts_bytes]`,
/// empty otherwise.
public fun create_spend_request(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    messages: vector<vector<u8>>,
    centralized_signatures: vector<vector<u8>>,
    expected_presign_cap_ids: vector<ID>,
    aux: vector<vector<u8>>,
    unverified: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(wallet.setup_complete, ESetupNotComplete);
    assert!(!wallet.paused, EPaused);
    assert_signer(wallet, ctx);
    assert!(amount > 0, EAmountZero);
    assert!(wallet.chains.contains(chain_key), EChainUnknown);

    // --- policy checks against the declared intent ---
    let (kind, curve, signature_algorithm, hash_scheme, fee_limit, evm_chain_id) = {
        let chain = wallet.chains.borrow(chain_key);
        assert!(chain.enabled, EChainDisabled);
        assert!(amount <= chain.per_tx_limit, EOverPerTxLimit);
        assert!(!chain.blocklist.contains(&destination), EDestinationBlocked);
        if (chain.allowlist_enabled) {
            assert!(chain.allowlist.contains(&destination), EDestinationNotAllowed);
        };
        if (unverified || chain.kind == KIND_GENERIC) {
            assert!(chain.allow_unverified, EUnverifiedNotAllowed);
        };
        (
            chain.kind,
            chain.curve,
            chain.signature_algorithm,
            chain.hash_scheme,
            chain.fee_limit,
            chain.evm_chain_id,
        )
    };

    // --- intent verification ---
    assert!(kind != KIND_SUI_VAULT, ENotVaultChain);
    let verified_intent = if (unverified || kind == KIND_GENERIC) {
        assert!(!messages.is_empty(), ENoMessages);
        false
    } else if (kind == KIND_BTC) {
        assert!(!messages.is_empty(), ENoMessages);
        assert!(aux.length() == 2, EBadChainConfig);
        let own_script = borrow_address_book(wallet, &chain_key);
        verify_btc::verify(
            &messages,
            aux.borrow(0),
            aux.borrow(1),
            own_script,
            &destination,
            amount,
            fee_limit,
        );
        true
    } else if (kind == KIND_EVM) {
        assert!(messages.length() == 1, EMessageCountMismatch);
        verify_evm::verify(
            messages.borrow(0),
            evm_chain_id,
            &asset,
            &destination,
            amount,
            fee_limit,
        );
        true
    } else if (kind == KIND_SOLANA) {
        assert!(messages.length() == 1, EMessageCountMismatch);
        let own_pubkey = borrow_address_book(wallet, &chain_key);
        verify_solana::verify_with_asset(messages.borrow(0), own_pubkey, &asset, &destination, amount);
        true
    } else {
        abort EBadChainConfig
    };

    // --- lock Ika future-sign capabilities ---
    let mut partial_sig_caps: vector<UnverifiedPartialUserSignatureCap> = vector::empty();
    {
        let n = messages.length();
        assert!(centralized_signatures.length() == n, EMessageCountMismatch);
        assert!(expected_presign_cap_ids.length() == n, EMessageCountMismatch);
        let dwallet_id = {
            assert!(wallet.dwallets.contains(curve), EDWalletMissing);
            wallet.dwallets.borrow(curve).dwallet_id
        };
        let (mut pay_ika, mut pay_sui) = withdraw_payments(wallet, ctx);
        let presign_key = PresignKey { curve, signature_algorithm };
        let mut i = 0;
        while (i < n) {
            let presign_cap = {
                assert!(wallet.presigns.contains(presign_key), ENoPresignAvailable);
                let pool = wallet.presigns.borrow_mut(presign_key);
                assert!(!pool.is_empty(), ENoPresignAvailable);
                pool.pop_back()
            };
            assert!(object::id(&presign_cap) == expected_presign_cap_ids[i], EPresignMismatch);
            assert!(coordinator.is_presign_valid(&presign_cap), EPresignNotReady);
            let verified_presign_cap = coordinator.verify_presign_cap(presign_cap, ctx);
            let session = fresh_session(coordinator, ctx);
            let partial_cap = coordinator.request_future_sign(
                dwallet_id,
                verified_presign_cap,
                messages[i],
                hash_scheme,
                centralized_signatures[i],
                session,
                &mut pay_ika,
                &mut pay_sui,
                ctx,
            );
            partial_sig_caps.push_back(partial_cap);
            i = i + 1;
        };
        return_payments(wallet, pay_ika, pay_sui);
    };

    // --- store the request ---
    let now = clock.timestamp_ms();
    store_request(
        wallet,
        chain_key,
        asset,
        destination,
        amount,
        verified_intent,
        messages,
        aux,
        partial_sig_caps,
        curve,
        signature_algorithm,
        hash_scheme,
        now,
        ctx,
    )
}

/// Creates a spend request for the native Sui vault. No Ika involvement;
/// the intent is the request itself, so it is always "verified".
public fun create_vault_spend_request(
    wallet: &mut PolicyWallet,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert!(wallet.setup_complete, ESetupNotComplete);
    assert!(!wallet.paused, EPaused);
    assert_signer(wallet, ctx);
    assert!(amount > 0, EAmountZero);
    assert!(wallet.chains.contains(chain_key), EChainUnknown);
    {
        let chain = wallet.chains.borrow(chain_key);
        assert!(chain.kind == KIND_SUI_VAULT, ENotVaultKind);
        assert!(chain.enabled, EChainDisabled);
        assert!(amount <= chain.per_tx_limit, EOverPerTxLimit);
        assert!(!chain.blocklist.contains(&destination), EDestinationBlocked);
        if (chain.allowlist_enabled) {
            assert!(chain.allowlist.contains(&destination), EDestinationNotAllowed);
        };
    };
    assert!(destination.length() == 32, EBadDestination);

    let now = clock.timestamp_ms();
    store_request(
        wallet,
        chain_key,
        asset,
        destination,
        amount,
        true,
        vector::empty(),
        vector::empty(),
        vector::empty(),
        0,
        0,
        0,
        now,
        ctx,
    )
}

fun store_request(
    wallet: &mut PolicyWallet,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    verified_intent: bool,
    messages: vector<vector<u8>>,
    aux: vector<vector<u8>>,
    partial_sig_caps: vector<UnverifiedPartialUserSignatureCap>,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    now: u64,
    ctx: &TxContext,
): u64 {
    wallet.request_counter = wallet.request_counter + 1;
    let request_id = wallet.request_counter;
    let mut approvals = vec_set::empty<address>();
    approvals.insert(ctx.sender());
    let message_count = messages.length();

    let request = SpendRequest {
        id: request_id,
        creator: ctx.sender(),
        chain_key,
        asset,
        destination,
        amount,
        verified_intent,
        messages,
        aux,
        partial_sig_caps,
        curve,
        signature_algorithm,
        hash_scheme,
        approvals,
        rejections: vec_set::empty(),
        created_at_ms: now,
        threshold_reached_at_ms: 0,
        status: STATUS_PENDING,
        sign_ids: vector::empty(),
    };
    wallet.requests.add(request_id, request);

    events::spend_request_created(
        object::id(wallet),
        request_id,
        ctx.sender(),
        chain_key,
        asset,
        destination,
        amount,
        verified_intent,
        message_count,
        now + wallet.request_expiry_ms,
    );
    events::spend_vote_cast(object::id(wallet), request_id, ctx.sender(), true, 1, 0);

    update_request_threshold_state(wallet, request_id, now);
    request_id
}

/// Casts an approval or rejection vote on a spend request. Votes are
/// irrevocable. Rejections permanently disable the single-approval fast
/// path for the request; once enough rejections accumulate that the
/// threshold can never be met, the request is auto-rejected.
/// While paused, only rejections are accepted.
public fun vote_spend(
    wallet: &mut PolicyWallet,
    request_id: u64,
    approve: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_signer(wallet, ctx);
    if (approve) {
        assert!(!wallet.paused, EPaused);
    };
    assert!(wallet.requests.contains(request_id), ERequestNotFound);
    let now = clock.timestamp_ms();
    let wallet_id = object::id(wallet);
    let expiry = wallet.request_expiry_ms;

    let (approvals, rejections) = {
        let request = wallet.requests.borrow_mut(request_id);
        assert!(request.status == STATUS_PENDING, ERequestNotPending);
        if (now > request.created_at_ms + expiry && request.threshold_reached_at_ms == 0) {
            request.status = STATUS_EXPIRED;
            events::spend_rejected(wallet_id, request_id);
            return
        };
        let sender = ctx.sender();
        assert!(
            !request.approvals.contains(&sender) && !request.rejections.contains(&sender),
            EAlreadyVoted,
        );
        if (approve) {
            request.approvals.insert(sender);
        } else {
            request.rejections.insert(sender);
        };
        (request.approvals.length(), request.rejections.length())
    };

    events::spend_vote_cast(wallet_id, request_id, ctx.sender(), approve, approvals, rejections);

    // Auto-reject when the threshold can no longer be reached.
    let n_signers = wallet.signers.length();
    let required = required_approvals_for(wallet, request_id);
    if (rejections > n_signers - required) {
        let request = wallet.requests.borrow_mut(request_id);
        request.status = STATUS_REJECTED;
        events::spend_rejected(wallet_id, request_id);
        return
    };

    update_request_threshold_state(wallet, request_id, now);
}

/// The creator may cancel their own pending request.
public fun cancel_spend(wallet: &mut PolicyWallet, request_id: u64, ctx: &TxContext) {
    assert!(wallet.requests.contains(request_id), ERequestNotFound);
    let wallet_id = object::id(wallet);
    let request = wallet.requests.borrow_mut(request_id);
    assert!(request.creator == ctx.sender(), ECreatorOnly);
    assert!(request.status == STATUS_PENDING, ERequestNotPending);
    request.status = STATUS_CANCELLED;
    events::spend_cancelled(wallet_id, request_id);
}

/// Executes an approved spend on an Ika-signed chain: re-validates the
/// policy, records window spend, then - and only then - produces the Ika
/// `MessageApproval`s and dispatches the signing sessions.
public fun execute_spend(
    wallet: &mut PolicyWallet,
    coordinator: &mut DWalletCoordinator,
    request_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(!wallet.paused, EPaused);
    let now = clock.timestamp_ms();
    let wallet_id = object::id(wallet);

    // Phase 1: validate and snapshot request data.
    let (chain_key, amount, curve, signature_algorithm, hash_scheme, messages) =
        validate_execution(wallet, request_id, now, false);

    // Phase 2: rolling window accounting (state change BEFORE signing).
    record_window_spend(wallet, &chain_key, amount, now);

    // Phase 3: extract the locked future-sign capabilities.
    let mut caps: vector<UnverifiedPartialUserSignatureCap> = vector::empty();
    {
        let request = wallet.requests.borrow_mut(request_id);
        while (!request.partial_sig_caps.is_empty()) {
            caps.push_back(request.partial_sig_caps.pop_back());
        };
        caps.reverse();
        request.status = STATUS_EXECUTED;
    };

    // Phase 4: approve + sign each message via the policy-held DWalletCap.
    let (mut pay_ika, mut pay_sui) = withdraw_payments(wallet, ctx);
    let mut sign_ids: vector<ID> = vector::empty();
    {
        let entry = wallet.dwallets.borrow(curve);
        while (!caps.is_empty()) {
            let unverified_cap = caps.pop_back();
            // caps were restored to message order; pop from the back and
            // index messages from the end correspondingly.
            let msg_index = caps.length();
            let verified_cap = coordinator.verify_partial_user_signature_cap(unverified_cap, ctx);
            let message_approval = coordinator.approve_message(
                &entry.cap,
                signature_algorithm,
                hash_scheme,
                messages[msg_index],
            );
            let session = fresh_session(coordinator, ctx);
            let sign_id = coordinator.request_sign_with_partial_user_signature_and_return_id(
                verified_cap,
                message_approval,
                session,
                &mut pay_ika,
                &mut pay_sui,
                ctx,
            );
            sign_ids.push_back(sign_id);
        };
        caps.destroy_empty();
    };
    return_payments(wallet, pay_ika, pay_sui);

    sign_ids.reverse();
    {
        let request = wallet.requests.borrow_mut(request_id);
        request.sign_ids = sign_ids;
    };
    events::spend_executed(wallet_id, request_id, ctx.sender(), sign_ids);
}

/// Executes an approved native-Sui vault spend: transfers the coins
/// directly to the destination address. No Ika involvement; the intent is
/// verified by construction.
public fun execute_vault_spend<T>(
    wallet: &mut PolicyWallet,
    request_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(!wallet.paused, EPaused);
    let now = clock.timestamp_ms();
    let wallet_id = object::id(wallet);

    let (chain_key, amount, _, _, _, _) = validate_execution(wallet, request_id, now, true);
    record_window_spend(wallet, &chain_key, amount, now);

    let (destination, asset) = {
        let request = wallet.requests.borrow_mut(request_id);
        request.status = STATUS_EXECUTED;
        (request.destination, request.asset)
    };

    let expected_type = type_name::get<T>().into_string().into_bytes();
    assert!(asset == expected_type, EVaultWrongAsset);
    assert!(amount <= U64_MAX, EVaultAmountTooLarge);
    let amount_u64 = amount as u64;

    let key = type_name::get<T>();
    assert!(wallet.vault.contains(key), EVaultInsufficient);
    let bal: &mut Balance<T> = wallet.vault.borrow_mut(key);
    assert!(bal.value() >= amount_u64, EVaultInsufficient);
    let payout = coin::from_balance(balance::split(bal, amount_u64), ctx);

    let dest_addr = sui_address::from_bytes(destination);
    transfer::public_transfer(payout, dest_addr);

    events::vault_withdrawal(wallet_id, request_id, expected_type, amount_u64, dest_addr);
    events::spend_executed(wallet_id, request_id, ctx.sender(), vector::empty());
}

// === Emergency controls ===

/// Any single signer can pause instantly. While paused: no new requests, no
/// approvals, no execution. Rejections and admin governance keep working so
/// the signer set can rotate keys / unpause.
public fun pause(wallet: &mut PolicyWallet, ctx: &TxContext) {
    assert_signer(wallet, ctx);
    assert!(!wallet.paused, EPaused);
    wallet.paused = true;
    events::wallet_paused(object::id(wallet), ctx.sender());
}

// === Admin proposals ===

/// Creates an admin proposal. Admin actions are gated by the (usually
/// higher) admin threshold, the admin timelock and a veto window.
public fun create_proposal(
    wallet: &mut PolicyWallet,
    action: u8,
    chain_key: vector<u8>,
    addr_param: Option<address>,
    bytes_param: vector<u8>,
    u_params: vector<u128>,
    bool_param: bool,
    clock: &Clock,
    ctx: &TxContext,
): u64 {
    assert_signer(wallet, ctx);
    validate_proposal(wallet, action, &chain_key, &addr_param, &u_params);

    wallet.proposal_counter = wallet.proposal_counter + 1;
    let proposal_id = wallet.proposal_counter;
    let now = clock.timestamp_ms();
    let mut approvals = vec_set::empty<address>();
    approvals.insert(ctx.sender());

    wallet.proposals.add(proposal_id, AdminProposal {
        id: proposal_id,
        creator: ctx.sender(),
        action,
        chain_key,
        addr_param,
        bytes_param,
        u_params,
        bool_param,
        approvals,
        rejections: vec_set::empty(),
        created_at_ms: now,
        threshold_reached_at_ms: 0,
        status: STATUS_PENDING,
    });

    events::proposal_created(
        object::id(wallet),
        proposal_id,
        ctx.sender(),
        action,
        chain_key,
        now + wallet.request_expiry_ms,
    );

    update_proposal_threshold_state(wallet, proposal_id, now);
    proposal_id
}

public fun vote_proposal(
    wallet: &mut PolicyWallet,
    proposal_id: u64,
    approve: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(wallet.proposals.contains(proposal_id), EProposalNotFound);
    let now = clock.timestamp_ms();
    let wallet_id = object::id(wallet);
    let expiry = wallet.request_expiry_ms;

    let (approvals, rejections) = {
        let proposal = wallet.proposals.borrow_mut(proposal_id);
        assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
        if (now > proposal.created_at_ms + expiry && proposal.threshold_reached_at_ms == 0) {
            proposal.status = STATUS_EXPIRED;
            events::proposal_rejected(wallet_id, proposal_id);
            return
        };
        let sender = ctx.sender();
        assert!(
            !proposal.approvals.contains(&sender) && !proposal.rejections.contains(&sender),
            EAlreadyVoted,
        );
        if (approve) {
            proposal.approvals.insert(sender);
        } else {
            proposal.rejections.insert(sender);
        };
        (proposal.approvals.length(), proposal.rejections.length())
    };

    events::proposal_vote_cast(wallet_id, proposal_id, ctx.sender(), approve, approvals, rejections);

    let n_signers = wallet.signers.length();
    if (rejections > n_signers - wallet.admin_threshold) {
        let proposal = wallet.proposals.borrow_mut(proposal_id);
        proposal.status = STATUS_REJECTED;
        events::proposal_rejected(wallet_id, proposal_id);
        return
    };

    update_proposal_threshold_state(wallet, proposal_id, now);
}

/// Executes a passed admin proposal after the admin timelock.
public fun execute_proposal(
    wallet: &mut PolicyWallet,
    registry: &mut Registry,
    proposal_id: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_signer(wallet, ctx);
    assert!(wallet.proposals.contains(proposal_id), EProposalNotFound);
    let now = clock.timestamp_ms();
    let wallet_id = object::id(wallet);

    let (action, chain_key, addr_param, bytes_param, u_params, bool_param) = {
        let proposal = wallet.proposals.borrow(proposal_id);
        assert!(proposal.status == STATUS_PENDING, EProposalNotPending);
        // Recount approvals against the CURRENT signer set.
        let valid = count_current_signers(wallet, &proposal.approvals);
        assert!(valid >= wallet.admin_threshold, EThresholdNotReached);
        assert!(proposal.threshold_reached_at_ms != 0, EThresholdNotReached);
        let executable_at = proposal.threshold_reached_at_ms + wallet.timelock_admin_ms;
        assert!(now >= executable_at, ETimelockActive);
        assert!(now <= executable_at + wallet.request_expiry_ms, ERequestExpired);
        (
            proposal.action,
            proposal.chain_key,
            proposal.addr_param,
            proposal.bytes_param,
            proposal.u_params,
            proposal.bool_param,
        )
    };

    apply_proposal(wallet, registry, action, chain_key, addr_param, bytes_param, u_params, bool_param, ctx);

    let proposal = wallet.proposals.borrow_mut(proposal_id);
    proposal.status = STATUS_EXECUTED;
    events::proposal_executed(wallet_id, proposal_id, action);
}

// === Views (for Move tests and PTB dev-inspect reads) ===

public fun signers(wallet: &PolicyWallet): vector<address> { wallet.signers }

public fun is_signer(wallet: &PolicyWallet, addr: address): bool {
    wallet.signers.contains(&addr)
}

public fun threshold(wallet: &PolicyWallet): u64 { wallet.threshold }

public fun admin_threshold(wallet: &PolicyWallet): u64 { wallet.admin_threshold }

public fun is_paused(wallet: &PolicyWallet): bool { wallet.paused }

public fun is_setup_complete(wallet: &PolicyWallet): bool { wallet.setup_complete }

public fun request_status(wallet: &PolicyWallet, request_id: u64): u8 {
    wallet.requests.borrow(request_id).status
}

public fun request_approvals(wallet: &PolicyWallet, request_id: u64): u64 {
    wallet.requests.borrow(request_id).approvals.length()
}

public fun proposal_status(wallet: &PolicyWallet, proposal_id: u64): u8 {
    wallet.proposals.borrow(proposal_id).status
}

public fun chain_spent_in_window(wallet: &PolicyWallet, chain_key: vector<u8>): u128 {
    wallet.chains.borrow(chain_key).spent_in_window
}

public fun address_book_entry(wallet: &PolicyWallet, chain_key: vector<u8>): vector<u8> {
    *wallet.address_book.borrow(chain_key)
}

public fun signer_cap_wallet_id(cap: &SignerCap): ID { cap.wallet_id }

// === Internal helpers ===

fun assert_signer(wallet: &PolicyWallet, ctx: &TxContext) {
    assert!(wallet.signers.contains(&ctx.sender()), ENotSigner);
}

fun borrow_address_book(wallet: &PolicyWallet, chain_key: &vector<u8>): &vector<u8> {
    assert!(wallet.address_book.contains(*chain_key), EAddressBookMissing);
    wallet.address_book.borrow(*chain_key)
}

fun fresh_session(coordinator: &mut DWalletCoordinator, ctx: &mut TxContext): SessionIdentifier {
    coordinator.register_session_identifier(ctx.fresh_object_address().to_bytes(), ctx)
}

fun withdraw_payments(wallet: &mut PolicyWallet, ctx: &mut TxContext): (Coin<IKA>, Coin<SUI>) {
    (
        wallet.ika_balance.withdraw_all().into_coin(ctx),
        wallet.sui_balance.withdraw_all().into_coin(ctx),
    )
}

fun return_payments(wallet: &mut PolicyWallet, pay_ika: Coin<IKA>, pay_sui: Coin<SUI>) {
    wallet.ika_balance.join(pay_ika.into_balance());
    wallet.sui_balance.join(pay_sui.into_balance());
}

fun count_current_signers(wallet: &PolicyWallet, set: &VecSet<address>): u64 {
    let keys = set.keys();
    let mut count = 0;
    let mut i = 0;
    while (i < keys.length()) {
        if (wallet.signers.contains(&keys[i])) {
            count = count + 1;
        };
        i = i + 1;
    };
    count
}

/// How many approvals this request needs right now. The fast path (single
/// approval, no timelock) applies only when ALL of: chain has a fast-path
/// limit, amount within it, intent verified on-chain, zero rejections.
fun is_fast_path(wallet: &PolicyWallet, request_id: u64): bool {
    let request = wallet.requests.borrow(request_id);
    let chain = wallet.chains.borrow(request.chain_key);
    chain.fast_path_limit > 0
        && request.amount <= chain.fast_path_limit
        && request.verified_intent
        && request.rejections.length() == 0
}

fun required_approvals_for(wallet: &PolicyWallet, request_id: u64): u64 {
    if (is_fast_path(wallet, request_id)) { 1 } else { wallet.threshold }
}

fun update_request_threshold_state(wallet: &mut PolicyWallet, request_id: u64, now: u64) {
    let required = required_approvals_for(wallet, request_id);
    let fast = is_fast_path(wallet, request_id);
    let timelock = if (fast) { 0 } else { wallet.timelock_spend_ms };
    let wallet_id = object::id(wallet);
    let valid_approvals = {
        let request = wallet.requests.borrow(request_id);
        count_current_signers(wallet, &request.approvals)
    };
    let request = wallet.requests.borrow_mut(request_id);
    if (request.threshold_reached_at_ms == 0 && valid_approvals >= required) {
        request.threshold_reached_at_ms = now;
        events::spend_threshold_reached(wallet_id, request_id, now + timelock);
    };
}

fun update_proposal_threshold_state(wallet: &mut PolicyWallet, proposal_id: u64, now: u64) {
    let required = wallet.admin_threshold;
    let timelock = wallet.timelock_admin_ms;
    let wallet_id = object::id(wallet);
    let valid_approvals = {
        let proposal = wallet.proposals.borrow(proposal_id);
        count_current_signers(wallet, &proposal.approvals)
    };
    let proposal = wallet.proposals.borrow_mut(proposal_id);
    if (proposal.threshold_reached_at_ms == 0 && valid_approvals >= required) {
        proposal.threshold_reached_at_ms = now;
        events::proposal_threshold_reached(wallet_id, proposal_id, now + timelock);
    };
}

/// Shared execution validation for Ika spends and vault spends. Returns a
/// snapshot of the fields execution needs.
fun validate_execution(
    wallet: &PolicyWallet,
    request_id: u64,
    now: u64,
    expect_vault: bool,
): (vector<u8>, u128, u32, u32, u32, vector<vector<u8>>) {
    assert!(wallet.requests.contains(request_id), ERequestNotFound);
    let request = wallet.requests.borrow(request_id);
    assert!(request.status == STATUS_PENDING, ERequestNotPending);

    let chain = wallet.chains.borrow(request.chain_key);
    assert!(chain.enabled, EChainDisabled);
    if (expect_vault) {
        assert!(chain.kind == KIND_SUI_VAULT, ENotVaultKind);
    } else {
        assert!(chain.kind != KIND_SUI_VAULT, ENotVaultChain);
    };

    // Threshold (recounted against the current signer set).
    let required = required_approvals_for(wallet, request_id);
    let valid_approvals = count_current_signers(wallet, &request.approvals);
    assert!(valid_approvals >= required, EThresholdNotReached);
    assert!(request.threshold_reached_at_ms != 0, EThresholdNotReached);

    // Timelock + execution window.
    let fast = chain.fast_path_limit > 0
        && request.amount <= chain.fast_path_limit
        && request.verified_intent
        && request.rejections.length() == 0;
    let timelock = if (fast) { 0 } else { wallet.timelock_spend_ms };
    let executable_at = request.threshold_reached_at_ms + timelock;
    assert!(now >= executable_at, ETimelockActive);
    assert!(now <= executable_at + wallet.request_expiry_ms, ERequestExpired);

    (
        request.chain_key,
        request.amount,
        request.curve,
        request.signature_algorithm,
        request.hash_scheme,
        request.messages,
    )
}

fun record_window_spend(wallet: &mut PolicyWallet, chain_key: &vector<u8>, amount: u128, now: u64) {
    let chain = wallet.chains.borrow_mut(*chain_key);
    if (now >= chain.window_started_at_ms + chain.window_ms) {
        chain.spent_in_window = 0;
        chain.window_started_at_ms = now;
    };
    assert!(chain.spent_in_window + amount <= chain.window_limit, EOverWindowLimit);
    chain.spent_in_window = chain.spent_in_window + amount;
}

fun validate_proposal(
    wallet: &PolicyWallet,
    action: u8,
    chain_key: &vector<u8>,
    addr_param: &Option<address>,
    u_params: &vector<u128>,
) {
    if (action == ACTION_ADD_SIGNER) {
        assert!(addr_param.is_some(), EBadProposal);
        assert!(!wallet.signers.contains(addr_param.borrow()), EDuplicateSigner);
        assert!(wallet.signers.length() < MAX_SIGNERS, ESignerLimit);
    } else if (action == ACTION_REMOVE_SIGNER) {
        assert!(addr_param.is_some(), EBadProposal);
        assert!(wallet.signers.contains(addr_param.borrow()), ENotSigner);
    } else if (action == ACTION_SET_THRESHOLDS) {
        assert!(u_params.length() == 2, EBadProposal);
    } else if (action == ACTION_SET_TIMELOCKS) {
        assert!(u_params.length() == 2, EBadProposal);
    } else if (action == ACTION_SET_EXPIRY) {
        assert!(u_params.length() == 1 && u_params[0] > 0, EBadProposal);
    } else if (action == ACTION_SET_CHAIN_LIMITS) {
        assert!(wallet.chains.contains(*chain_key), EChainUnknown);
        assert!(u_params.length() == 5, EBadProposal);
    } else if (
        action == ACTION_ALLOWLIST_ADD || action == ACTION_ALLOWLIST_REMOVE
            || action == ACTION_BLOCKLIST_ADD || action == ACTION_BLOCKLIST_REMOVE
            || action == ACTION_SET_CHAIN_ENABLED || action == ACTION_SET_ALLOWLIST_ENABLED
            || action == ACTION_SET_ALLOW_UNVERIFIED || action == ACTION_SET_ADDRESS_BOOK
    ) {
        assert!(wallet.chains.contains(*chain_key) || action == ACTION_SET_ADDRESS_BOOK, EChainUnknown);
    } else if (action == ACTION_UNPAUSE) {
        assert!(wallet.paused, ENotPaused);
    } else if (action == ACTION_WITHDRAW_RESERVES) {
        assert!(addr_param.is_some(), EBadProposal);
        assert!(u_params.length() == 2, EBadProposal);
    } else {
        abort EBadProposal
    }
}

fun apply_proposal(
    wallet: &mut PolicyWallet,
    registry: &mut Registry,
    action: u8,
    chain_key: vector<u8>,
    addr_param: Option<address>,
    bytes_param: vector<u8>,
    u_params: vector<u128>,
    bool_param: bool,
    ctx: &mut TxContext,
) {
    let wallet_id = object::id(wallet);
    if (action == ACTION_ADD_SIGNER) {
        let new_signer = *addr_param.borrow();
        assert!(!wallet.signers.contains(&new_signer), EDuplicateSigner);
        assert!(wallet.signers.length() < MAX_SIGNERS, ESignerLimit);
        wallet.signers.push_back(new_signer);
        registry.add_signer(new_signer, wallet_id);
        transfer::transfer(SignerCap { id: object::new(ctx), wallet_id }, new_signer);
        events::signer_added(wallet_id, new_signer);
    } else if (action == ACTION_REMOVE_SIGNER) {
        let gone = *addr_param.borrow();
        let (found, idx) = wallet.signers.index_of(&gone);
        assert!(found, ENotSigner);
        let remaining = wallet.signers.length() - 1;
        assert!(remaining >= wallet.threshold && remaining >= wallet.admin_threshold, EBadThreshold);
        wallet.signers.swap_remove(idx);
        registry.remove_signer(gone, wallet_id);
        events::signer_removed(wallet_id, gone);
    } else if (action == ACTION_SET_THRESHOLDS) {
        let new_threshold = u_params[0];
        let new_admin = u_params[1];
        let n = (wallet.signers.length() as u128);
        assert!(new_threshold >= 1 && new_threshold <= n, EBadThreshold);
        assert!(new_admin >= new_threshold && new_admin <= n, EBadThreshold);
        wallet.threshold = new_threshold as u64;
        wallet.admin_threshold = new_admin as u64;
    } else if (action == ACTION_SET_TIMELOCKS) {
        assert!(u_params[0] <= U64_MAX && u_params[1] <= U64_MAX, EBadProposal);
        wallet.timelock_spend_ms = u_params[0] as u64;
        wallet.timelock_admin_ms = u_params[1] as u64;
    } else if (action == ACTION_SET_EXPIRY) {
        assert!(u_params[0] > 0 && u_params[0] <= U64_MAX, EBadProposal);
        wallet.request_expiry_ms = u_params[0] as u64;
    } else if (action == ACTION_SET_CHAIN_LIMITS) {
        let chain = wallet.chains.borrow_mut(chain_key);
        let fast = u_params[0];
        let per_tx = u_params[1];
        let window_limit = u_params[2];
        let window_ms = u_params[3];
        let fee_limit = u_params[4];
        assert!(per_tx > 0 && fast <= per_tx && window_limit >= per_tx, EBadChainConfig);
        assert!(window_ms > 0 && window_ms <= U64_MAX, EBadChainConfig);
        chain.fast_path_limit = fast;
        chain.per_tx_limit = per_tx;
        chain.window_limit = window_limit;
        chain.window_ms = window_ms as u64;
        chain.fee_limit = fee_limit;
    } else if (action == ACTION_ALLOWLIST_ADD) {
        let chain = wallet.chains.borrow_mut(chain_key);
        if (!chain.allowlist.contains(&bytes_param)) {
            chain.allowlist.insert(bytes_param);
        };
    } else if (action == ACTION_ALLOWLIST_REMOVE) {
        let chain = wallet.chains.borrow_mut(chain_key);
        if (chain.allowlist.contains(&bytes_param)) {
            chain.allowlist.remove(&bytes_param);
        };
    } else if (action == ACTION_BLOCKLIST_ADD) {
        let chain = wallet.chains.borrow_mut(chain_key);
        if (!chain.blocklist.contains(&bytes_param)) {
            chain.blocklist.insert(bytes_param);
        };
    } else if (action == ACTION_BLOCKLIST_REMOVE) {
        let chain = wallet.chains.borrow_mut(chain_key);
        if (chain.blocklist.contains(&bytes_param)) {
            chain.blocklist.remove(&bytes_param);
        };
    } else if (action == ACTION_UNPAUSE) {
        assert!(wallet.paused, ENotPaused);
        wallet.paused = false;
        events::wallet_unpaused(wallet_id);
    } else if (action == ACTION_SET_ADDRESS_BOOK) {
        if (wallet.address_book.contains(chain_key)) {
            *wallet.address_book.borrow_mut(chain_key) = bytes_param;
        } else {
            wallet.address_book.add(chain_key, bytes_param);
        };
        events::address_recorded(wallet_id, chain_key, bytes_param);
    } else if (action == ACTION_SET_CHAIN_ENABLED) {
        let chain = wallet.chains.borrow_mut(chain_key);
        chain.enabled = bool_param;
        events::chain_configured(wallet_id, chain_key, chain.kind, bool_param);
    } else if (action == ACTION_SET_ALLOWLIST_ENABLED) {
        let chain = wallet.chains.borrow_mut(chain_key);
        chain.allowlist_enabled = bool_param;
    } else if (action == ACTION_SET_ALLOW_UNVERIFIED) {
        let chain = wallet.chains.borrow_mut(chain_key);
        chain.allow_unverified = bool_param;
    } else if (action == ACTION_WITHDRAW_RESERVES) {
        let recipient = *addr_param.borrow();
        let ika_amount = u_params[0];
        let sui_amount = u_params[1];
        assert!(ika_amount <= U64_MAX && sui_amount <= U64_MAX, EBadProposal);
        if (ika_amount > 0) {
            let coin_ika = coin::from_balance(
                wallet.ika_balance.split(ika_amount as u64),
                ctx,
            );
            transfer::public_transfer(coin_ika, recipient);
        };
        if (sui_amount > 0) {
            let coin_sui = coin::from_balance(
                wallet.sui_balance.split(sui_amount as u64),
                ctx,
            );
            transfer::public_transfer(coin_sui, recipient);
        };
    } else {
        abort EBadProposal
    }
}

// === Test-only helpers ===

#[test_only]
public fun create_wallet_for_testing(
    registry: &mut Registry,
    signers: vector<address>,
    threshold: u64,
    admin_threshold: u64,
    timelock_spend_ms: u64,
    timelock_admin_ms: u64,
    request_expiry_ms: u64,
    ctx: &mut TxContext,
): ID {
    let n = signers.length();
    assert!(n >= 1 && n <= MAX_SIGNERS, ETooFewSigners);
    assert!(threshold >= 1 && threshold <= n, EBadThreshold);
    assert!(admin_threshold >= threshold && admin_threshold <= n, EBadThreshold);
    assert!(request_expiry_ms > 0, EExpiryZero);

    let wallet = PolicyWallet {
        id: object::new(ctx),
        creator: ctx.sender(),
        signers,
        threshold,
        admin_threshold,
        timelock_spend_ms,
        timelock_admin_ms,
        request_expiry_ms,
        paused: false,
        setup_complete: false,
        dwallets: table::new(ctx),
        presigns: table::new(ctx),
        network_encryption_key_id: object::id_from_address(@0x0),
        ika_balance: balance::zero(),
        sui_balance: balance::zero(),
        chains: table::new(ctx),
        address_book: table::new(ctx),
        requests: table::new(ctx),
        request_counter: 0,
        proposals: table::new(ctx),
        proposal_counter: 0,
        vault: bag::new(ctx),
    };

    let wallet_id = object::id(&wallet);
    registry.register_wallet();
    let mut i = 0;
    while (i < wallet.signers.length()) {
        let signer_addr = wallet.signers[i];
        registry.add_signer(signer_addr, wallet_id);
        transfer::transfer(SignerCap { id: object::new(ctx), wallet_id }, signer_addr);
        i = i + 1;
    };
    transfer::share_object(wallet);
    wallet_id
}

#[test_only]
public fun request_threshold_reached_at(wallet: &PolicyWallet, request_id: u64): u64 {
    wallet.requests.borrow(request_id).threshold_reached_at_ms
}

#[test_only]
public fun request_verified_intent(wallet: &PolicyWallet, request_id: u64): bool {
    wallet.requests.borrow(request_id).verified_intent
}

#[test_only]
public fun vault_balance_for_testing<T>(wallet: &PolicyWallet): u64 {
    let key = type_name::get<T>();
    if (wallet.vault.contains(key)) {
        let bal: &Balance<T> = wallet.vault.borrow(key);
        bal.value()
    } else {
        0
    }
}
