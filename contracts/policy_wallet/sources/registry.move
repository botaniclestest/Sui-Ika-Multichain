// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// Durable wallet discovery.
///
/// A single shared `Registry` object is created when the package is
/// published. Every policy wallet registers each of its signers here, so a
/// signer who has lost every local cache can recover all wallets they belong
/// to with one dynamic-field read against this object - no indexer, no
/// third-party service, no frontend required.
///
/// Discovery paths, in order of preference:
///   1. Owned `SignerCap` objects (queryable via `getOwnedObjects`).
///   2. This registry (`Table<address, vector<ID>>` lookup).
///   3. `WalletCreated` / `SignerAdded` events (slowest, needs event scan).
module policy_wallet::registry;

use sui::table::{Self, Table};

public struct Registry has key {
    id: UID,
    /// signer address -> ids of every wallet that signer belongs to.
    wallets_by_signer: Table<address, vector<ID>>,
    /// total number of wallets ever created (diagnostic / pagination aid).
    wallet_count: u64,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry {
        id: object::new(ctx),
        wallets_by_signer: table::new(ctx),
        wallet_count: 0,
    });
}

public(package) fun register_wallet(self: &mut Registry) {
    self.wallet_count = self.wallet_count + 1;
}

public(package) fun add_signer(self: &mut Registry, signer_addr: address, wallet_id: ID) {
    if (!self.wallets_by_signer.contains(signer_addr)) {
        self.wallets_by_signer.add(signer_addr, vector::empty());
    };
    let list = self.wallets_by_signer.borrow_mut(signer_addr);
    if (!list.contains(&wallet_id)) {
        list.push_back(wallet_id);
    };
}

public(package) fun remove_signer(self: &mut Registry, signer_addr: address, wallet_id: ID) {
    if (!self.wallets_by_signer.contains(signer_addr)) return;
    let list = self.wallets_by_signer.borrow_mut(signer_addr);
    let (found, idx) = list.index_of(&wallet_id);
    if (found) {
        list.swap_remove(idx);
    };
}

public fun wallets_of(self: &Registry, signer_addr: address): vector<ID> {
    if (self.wallets_by_signer.contains(signer_addr)) {
        *self.wallets_by_signer.borrow(signer_addr)
    } else {
        vector::empty()
    }
}

public fun wallet_count(self: &Registry): u64 {
    self.wallet_count
}

#[test_only]
public fun new_for_testing(ctx: &mut TxContext): Registry {
    Registry {
        id: object::new(ctx),
        wallets_by_signer: table::new(ctx),
        wallet_count: 0,
    }
}

#[test_only]
public fun share_for_testing(self: Registry) {
    transfer::share_object(self);
}
