// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// All events emitted by the policy wallet. Events are the durable audit
/// trail: together with the shared wallet object and the registry, they let
/// any signer rebuild the complete wallet history from a fresh client with
/// nothing but a Sui RPC endpoint.
module policy_wallet::events;

use sui::event;

public struct WalletCreated has copy, drop {
    wallet_id: ID,
    creator: address,
    signers: vector<address>,
    threshold: u64,
    admin_threshold: u64,
    dwallet_id: ID,
    dwallet_cap_id: ID,
}

public struct DWalletAdded has copy, drop {
    wallet_id: ID,
    curve: u32,
    dwallet_id: ID,
    dwallet_cap_id: ID,
}

public struct ChainConfigured has copy, drop {
    wallet_id: ID,
    chain_key: vector<u8>,
    kind: u8,
    enabled: bool,
}

public struct AddressRecorded has copy, drop {
    wallet_id: ID,
    chain_key: vector<u8>,
    identity: vector<u8>,
}

public struct SetupFinalized has copy, drop {
    wallet_id: ID,
}

public struct SpendRequestCreated has copy, drop {
    wallet_id: ID,
    request_id: u64,
    creator: address,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    verified_intent: bool,
    message_count: u64,
    expires_at_ms: u64,
}

public struct SpendVoteCast has copy, drop {
    wallet_id: ID,
    request_id: u64,
    voter: address,
    approve: bool,
    approvals: u64,
    rejections: u64,
}

public struct SpendThresholdReached has copy, drop {
    wallet_id: ID,
    request_id: u64,
    executable_at_ms: u64,
}

public struct ProposalThresholdReached has copy, drop {
    wallet_id: ID,
    proposal_id: u64,
    executable_at_ms: u64,
}

public struct SpendExecuted has copy, drop {
    wallet_id: ID,
    request_id: u64,
    executor: address,
    sign_ids: vector<ID>,
}

public struct SpendRejected has copy, drop {
    wallet_id: ID,
    request_id: u64,
}

public struct SpendCancelled has copy, drop {
    wallet_id: ID,
    request_id: u64,
}

public struct ProposalCreated has copy, drop {
    wallet_id: ID,
    proposal_id: u64,
    creator: address,
    action: u8,
    chain_key: vector<u8>,
    expires_at_ms: u64,
}

public struct ProposalVoteCast has copy, drop {
    wallet_id: ID,
    proposal_id: u64,
    voter: address,
    approve: bool,
    approvals: u64,
    rejections: u64,
}

public struct ProposalExecuted has copy, drop {
    wallet_id: ID,
    proposal_id: u64,
    action: u8,
}

public struct ProposalRejected has copy, drop {
    wallet_id: ID,
    proposal_id: u64,
}

public struct WalletPaused has copy, drop {
    wallet_id: ID,
    by: address,
}

public struct WalletUnpaused has copy, drop {
    wallet_id: ID,
}

public struct SignerAdded has copy, drop {
    wallet_id: ID,
    signer: address,
}

public struct SignerRemoved has copy, drop {
    wallet_id: ID,
    signer: address,
}

public struct PresignAdded has copy, drop {
    wallet_id: ID,
    curve: u32,
    signature_algorithm: u32,
    presign_cap_id: ID,
}

public struct BalanceDeposited has copy, drop {
    wallet_id: ID,
    ika_amount: u64,
    sui_amount: u64,
}

public struct VaultDeposit has copy, drop {
    wallet_id: ID,
    coin_type: vector<u8>,
    amount: u64,
}

public struct VaultWithdrawal has copy, drop {
    wallet_id: ID,
    request_id: u64,
    coin_type: vector<u8>,
    amount: u64,
    destination: address,
}

public struct AssetLimitsSet has copy, drop {
    wallet_id: ID,
    chain_key: vector<u8>,
    asset: vector<u8>,
    fast_path_limit: u128,
    per_tx_limit: u128,
    window_limit: u128,
    window_ms: u64,
}

public struct AssetLimitsRemoved has copy, drop {
    wallet_id: ID,
    chain_key: vector<u8>,
    asset: vector<u8>,
}

// === Emit helpers (package-internal) ===

public(package) fun wallet_created(
    wallet_id: ID,
    creator: address,
    signers: vector<address>,
    threshold: u64,
    admin_threshold: u64,
    dwallet_id: ID,
    dwallet_cap_id: ID,
) {
    event::emit(WalletCreated {
        wallet_id, creator, signers, threshold, admin_threshold, dwallet_id, dwallet_cap_id,
    });
}

public(package) fun dwallet_added(wallet_id: ID, curve: u32, dwallet_id: ID, dwallet_cap_id: ID) {
    event::emit(DWalletAdded { wallet_id, curve, dwallet_id, dwallet_cap_id });
}

public(package) fun chain_configured(wallet_id: ID, chain_key: vector<u8>, kind: u8, enabled: bool) {
    event::emit(ChainConfigured { wallet_id, chain_key, kind, enabled });
}

public(package) fun address_recorded(wallet_id: ID, chain_key: vector<u8>, identity: vector<u8>) {
    event::emit(AddressRecorded { wallet_id, chain_key, identity });
}

public(package) fun setup_finalized(wallet_id: ID) {
    event::emit(SetupFinalized { wallet_id });
}

public(package) fun spend_request_created(
    wallet_id: ID,
    request_id: u64,
    creator: address,
    chain_key: vector<u8>,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u128,
    verified_intent: bool,
    message_count: u64,
    expires_at_ms: u64,
) {
    event::emit(SpendRequestCreated {
        wallet_id, request_id, creator, chain_key, asset, destination, amount,
        verified_intent, message_count, expires_at_ms,
    });
}

public(package) fun spend_vote_cast(
    wallet_id: ID,
    request_id: u64,
    voter: address,
    approve: bool,
    approvals: u64,
    rejections: u64,
) {
    event::emit(SpendVoteCast { wallet_id, request_id, voter, approve, approvals, rejections });
}

public(package) fun spend_threshold_reached(wallet_id: ID, request_id: u64, executable_at_ms: u64) {
    event::emit(SpendThresholdReached { wallet_id, request_id, executable_at_ms });
}

public(package) fun proposal_threshold_reached(wallet_id: ID, proposal_id: u64, executable_at_ms: u64) {
    event::emit(ProposalThresholdReached { wallet_id, proposal_id, executable_at_ms });
}

public(package) fun spend_executed(wallet_id: ID, request_id: u64, executor: address, sign_ids: vector<ID>) {
    event::emit(SpendExecuted { wallet_id, request_id, executor, sign_ids });
}

public(package) fun spend_rejected(wallet_id: ID, request_id: u64) {
    event::emit(SpendRejected { wallet_id, request_id });
}

public(package) fun spend_cancelled(wallet_id: ID, request_id: u64) {
    event::emit(SpendCancelled { wallet_id, request_id });
}

public(package) fun proposal_created(
    wallet_id: ID,
    proposal_id: u64,
    creator: address,
    action: u8,
    chain_key: vector<u8>,
    expires_at_ms: u64,
) {
    event::emit(ProposalCreated { wallet_id, proposal_id, creator, action, chain_key, expires_at_ms });
}

public(package) fun proposal_vote_cast(
    wallet_id: ID,
    proposal_id: u64,
    voter: address,
    approve: bool,
    approvals: u64,
    rejections: u64,
) {
    event::emit(ProposalVoteCast { wallet_id, proposal_id, voter, approve, approvals, rejections });
}

public(package) fun proposal_executed(wallet_id: ID, proposal_id: u64, action: u8) {
    event::emit(ProposalExecuted { wallet_id, proposal_id, action });
}

public(package) fun proposal_rejected(wallet_id: ID, proposal_id: u64) {
    event::emit(ProposalRejected { wallet_id, proposal_id });
}

public(package) fun wallet_paused(wallet_id: ID, by: address) {
    event::emit(WalletPaused { wallet_id, by });
}

public(package) fun wallet_unpaused(wallet_id: ID) {
    event::emit(WalletUnpaused { wallet_id });
}

public(package) fun signer_added(wallet_id: ID, signer: address) {
    event::emit(SignerAdded { wallet_id, signer });
}

public(package) fun signer_removed(wallet_id: ID, signer: address) {
    event::emit(SignerRemoved { wallet_id, signer });
}

public(package) fun presign_added(wallet_id: ID, curve: u32, signature_algorithm: u32, presign_cap_id: ID) {
    event::emit(PresignAdded { wallet_id, curve, signature_algorithm, presign_cap_id });
}

public(package) fun balance_deposited(wallet_id: ID, ika_amount: u64, sui_amount: u64) {
    event::emit(BalanceDeposited { wallet_id, ika_amount, sui_amount });
}

public(package) fun vault_deposit(wallet_id: ID, coin_type: vector<u8>, amount: u64) {
    event::emit(VaultDeposit { wallet_id, coin_type, amount });
}

public(package) fun vault_withdrawal(
    wallet_id: ID,
    request_id: u64,
    coin_type: vector<u8>,
    amount: u64,
    destination: address,
) {
    event::emit(VaultWithdrawal { wallet_id, request_id, coin_type, amount, destination });
}

public(package) fun asset_limits_set(
    wallet_id: ID,
    chain_key: vector<u8>,
    asset: vector<u8>,
    fast_path_limit: u128,
    per_tx_limit: u128,
    window_limit: u128,
    window_ms: u64,
) {
    event::emit(AssetLimitsSet {
        wallet_id, chain_key, asset, fast_path_limit, per_tx_limit, window_limit, window_ms,
    });
}

public(package) fun asset_limits_removed(wallet_id: ID, chain_key: vector<u8>, asset: vector<u8>) {
    event::emit(AssetLimitsRemoved { wallet_id, chain_key, asset });
}
