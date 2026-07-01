// Mythos Policy Wallet - per-asset limit override & governance expiry tests
// SPDX-License-Identifier: BSD-3-Clause-Clear
#[test_only]
module policy_wallet::asset_limit_tests;

use policy_wallet::policy_wallet::{Self as pw, PolicyWallet};
use policy_wallet::registry::{Self, Registry};
use std::type_name;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const RECIPIENT: address = @0x123456;

const VAULT_CHAIN: vector<u8> = b"sui:vault";
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

// Chain (native SUI) limits: fast=1 SUI, per-tx=100 SUI, window=150 SUI/day.
const FAST: u128 = 1_000_000_000;
const PER_TX: u128 = 100_000_000_000;
const WINDOW: u128 = 150_000_000_000;

const ACTION_SET_ASSET_LIMITS: u8 = 17;
const ACTION_REMOVE_ASSET_LIMITS: u8 = 18;

/// A non-native vault coin (stands in for any token: ERC-20 / SPL / Sui coin).
public struct FAKE has drop {}

fun fake_type_bytes(): vector<u8> {
    type_name::get<FAKE>().into_string().into_bytes()
}

fun sui_type_bytes(): vector<u8> {
    type_name::get<SUI>().into_string().into_bytes()
}

fun dest_bytes(): vector<u8> {
    sui::address::to_bytes(RECIPIENT)
}

fun setup(scenario: &mut Scenario): Clock {
    ts::next_tx(scenario, ALICE);
    let reg = registry::new_for_testing(ts::ctx(scenario));
    registry::share_for_testing(reg);

    ts::next_tx(scenario, ALICE);
    {
        let mut reg = ts::take_shared<Registry>(scenario);
        pw::create_wallet_for_testing(
            &mut reg,
            vector[ALICE, BOB, CAROL],
            2, // threshold
            3, // admin threshold
            HOUR_MS, // spend timelock
            2 * HOUR_MS, // admin timelock
            DAY_MS, // request expiry
            ts::ctx(scenario),
        );
        ts::return_shared(reg);
    };

    ts::next_tx(scenario, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(scenario);
        pw::configure_chain(
            &mut wallet,
            VAULT_CHAIN,
            3, // KIND_SUI_VAULT
            0,
            FAST,
            PER_TX,
            WINDOW,
            DAY_MS,
            0,
            false,
            false,
            ts::ctx(scenario),
        );
        pw::finalize_setup(&mut wallet, ts::ctx(scenario));
        // fund vault: 200 SUI + 10_000 FAKE (9 decimals -> 10^13 base units)
        pw::vault_deposit(&mut wallet, coin::mint_for_testing<SUI>(200_000_000_000, ts::ctx(scenario)));
        pw::vault_deposit(&mut wallet, coin::mint_for_testing<FAKE>(10_000_000_000_000, ts::ctx(scenario)));
        ts::return_shared(wallet);
    };

    let mut c = clock::create_for_testing(ts::ctx(scenario));
    c.set_for_testing(1_000_000);
    c
}

/// Passes an admin proposal with all three signers and executes it.
fun pass_proposal(
    s: &mut Scenario,
    c: &mut Clock,
    action: u8,
    chain_key: vector<u8>,
    bytes_param: vector<u8>,
    u_params: vector<u128>,
): u64 {
    ts::next_tx(s, ALICE);
    let pid = {
        let mut wallet = ts::take_shared<PolicyWallet>(s);
        let pid = pw::create_proposal(
            &mut wallet, action, chain_key, option::none(), bytes_param, u_params, false,
            c, ts::ctx(s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(s);
        pw::vote_proposal(&mut wallet, pid, true, c, ts::ctx(s));
        ts::return_shared(wallet);
    };
    ts::next_tx(s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(s);
        pw::vote_proposal(&mut wallet, pid, true, c, ts::ctx(s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(s);
        let mut reg = ts::take_shared<Registry>(s);
        pw::execute_proposal(&mut wallet, &mut reg, pid, c, ts::ctx(s));
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };
    pid
}

// === Default: non-native assets are UNLIMITED (full threshold + timelock) ===

#[test]
fun token_without_override_is_unlimited_but_never_fast_path() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // Amount FAR above the chain's native per-tx limit: allowed for a token.
    let big: u128 = 5_000_000_000_000; // 5000 FAKE > 100 SUI chain cap
    ts::next_tx(&mut s, ALICE);
    let id = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        assert!(pw::asset_per_tx_limit(&wallet, VAULT_CHAIN, fake_type_bytes()).is_none());
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(), big, &c, ts::ctx(&mut s),
        );
        // even a tiny token amount would not fast-path: full threshold required
        assert!(pw::request_threshold_reached_at(&wallet, id) == 0);
        ts::return_shared(wallet);
        id
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id, true, &c, ts::ctx(&mut s));
        assert!(pw::request_threshold_reached_at(&wallet, id) > 0);
        ts::return_shared(wallet);
    };
    c.increment_for_testing(HOUR_MS + 1);
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::execute_vault_spend<FAKE>(&mut wallet, id, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, id) == 1);
        // token spends never touch the native chain window
        assert!(pw::chain_spent_in_window(&wallet, VAULT_CHAIN) == 0);
        assert!(pw::vault_balance_for_testing<FAKE>(&wallet) == 5_000_000_000_000);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
fun token_small_amount_still_requires_full_threshold() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        // 0.5 FAKE - below the chain's SUI fast-path limit, but token units
        // are incomparable: no fast path without a token override.
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            500_000_000, &c, ts::ctx(&mut s),
        );
        assert!(pw::request_threshold_reached_at(&wallet, id) == 0);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

// === SET_ASSET_LIMITS ===

#[test]
fun set_asset_limits_via_proposal() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // fast=1 FAKE, per-tx=10 FAKE, window=15 FAKE / day
    pass_proposal(
        &mut s, &mut c, ACTION_SET_ASSET_LIMITS, VAULT_CHAIN, fake_type_bytes(),
        vector[1_000_000_000, 10_000_000_000, 15_000_000_000, (DAY_MS as u128)],
    );

    ts::next_tx(&mut s, ALICE);
    {
        let wallet = ts::take_shared<PolicyWallet>(&s);
        assert!(pw::asset_policy_exists(&wallet, VAULT_CHAIN, fake_type_bytes()));
        let limit = pw::asset_per_tx_limit(&wallet, VAULT_CHAIN, fake_type_bytes());
        assert!(limit.is_some() && *limit.borrow() == 10_000_000_000);
        ts::return_shared(wallet);
    };

    // fast path now works for the token within its own limit
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            500_000_000, // 0.5 FAKE <= 1 FAKE fast path
            &c, ts::ctx(&mut s),
        );
        assert!(pw::request_threshold_reached_at(&wallet, id) > 0);
        pw::execute_vault_spend<FAKE>(&mut wallet, id, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, id) == 1);
        assert!(pw::asset_spent_in_window(&wallet, VAULT_CHAIN, fake_type_bytes()) == 500_000_000);
        assert!(pw::chain_spent_in_window(&wallet, VAULT_CHAIN) == 0);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = pw::EOverPerTxLimit)]
fun asset_per_tx_limit_enforced_after_override() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
    pass_proposal(
        &mut s, &mut c, ACTION_SET_ASSET_LIMITS, VAULT_CHAIN, fake_type_bytes(),
        vector[1_000_000_000, 10_000_000_000, 15_000_000_000, (DAY_MS as u128)],
    );
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            10_000_000_001, // over the 10 FAKE token cap
            &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::EOverWindowLimit)]
fun asset_window_limit_enforced() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
    pass_proposal(
        &mut s, &mut c, ACTION_SET_ASSET_LIMITS, VAULT_CHAIN, fake_type_bytes(),
        vector[0, 10_000_000_000, 15_000_000_000, (DAY_MS as u128)],
    );

    // First 10 FAKE spend fits the 15 FAKE window.
    ts::next_tx(&mut s, ALICE);
    let id1 = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            10_000_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        id
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id1, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::execute_vault_spend<FAKE>(&mut wallet, id1, &c, ts::ctx(&mut s));
        assert!(pw::asset_spent_in_window(&wallet, VAULT_CHAIN, fake_type_bytes()) == 10_000_000_000);
        ts::return_shared(wallet);
    };

    // Second 10 FAKE spend in the same window busts the 15 FAKE cap.
    ts::next_tx(&mut s, ALICE);
    let id2 = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            10_000_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        id
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id2, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::execute_vault_spend<FAKE>(&mut wallet, id2, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
fun remove_asset_limits_restores_unlimited() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
    pass_proposal(
        &mut s, &mut c, ACTION_SET_ASSET_LIMITS, VAULT_CHAIN, fake_type_bytes(),
        vector[0, 10_000_000_000, 15_000_000_000, (DAY_MS as u128)],
    );
    pass_proposal(
        &mut s, &mut c, ACTION_REMOVE_ASSET_LIMITS, VAULT_CHAIN, fake_type_bytes(),
        vector::empty(),
    );

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        assert!(!pw::asset_policy_exists(&wallet, VAULT_CHAIN, fake_type_bytes()));
        // over the removed 10 FAKE cap: allowed again (unlimited)
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, fake_type_bytes(), dest_bytes(),
            50_000_000_000, &c, ts::ctx(&mut s),
        );
        assert!(pw::request_threshold_reached_at(&wallet, id) == 0); // no fast path
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = pw::EBadProposal)]
fun set_asset_limits_rejects_native_asset() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        // SUI is the vault chain's native asset: use SET_CHAIN_LIMITS instead.
        pw::create_proposal(
            &mut wallet, ACTION_SET_ASSET_LIMITS, VAULT_CHAIN, option::none(),
            sui_type_bytes(),
            vector[0, 10_000_000_000, 15_000_000_000, (DAY_MS as u128)],
            false, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::EOverPerTxLimit)]
fun native_sui_vault_asset_still_uses_chain_limits() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            PER_TX + 1, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

// === Governance expiry: stale proposals/requests stop collecting votes ===

#[test]
fun stale_threshold_reached_proposal_expires_for_late_voter() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
    let dave: address = @0xDA4E;

    // Proposal A reaches the admin threshold but is never executed.
    ts::next_tx(&mut s, ALICE);
    let pid_a = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid = pw::create_proposal(
            &mut wallet, 4 /* SET_TIMELOCKS */, vector::empty(), option::none(),
            vector::empty(), vector[(HOUR_MS as u128), (2 * HOUR_MS as u128)], false,
            &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid_a, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid_a, true, &c, ts::ctx(&mut s));
        assert!(pw::proposal_status(&wallet, pid_a) == 0); // pending
        ts::return_shared(wallet);
    };

    // Its execution window (admin timelock + expiry) lapses.
    c.increment_for_testing(2 * HOUR_MS + DAY_MS + 2);

    // Dave is added as a signer afterwards (fresh ADD_SIGNER proposal).
    ts::next_tx(&mut s, ALICE);
    let pid_add = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid = pw::create_proposal(
            &mut wallet, 1 /* ADD_SIGNER */, vector::empty(), option::some(dave),
            vector::empty(), vector::empty(), false, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid_add, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid_add, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let mut reg = ts::take_shared<Registry>(&s);
        pw::execute_proposal(&mut wallet, &mut reg, pid_add, &c, ts::ctx(&mut s));
        assert!(pw::is_signer(&wallet, dave));
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };

    // The newly added signer tries to vote on the stale proposal A: it must
    // lazily expire instead of accepting the vote (previously this proposal
    // stayed votable forever once its threshold had been reached).
    ts::next_tx(&mut s, dave);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid_a, true, &c, ts::ctx(&mut s));
        assert!(pw::proposal_status(&wallet, pid_a) == 4); // expired
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
fun stale_threshold_reached_request_expires_for_late_voter() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // Request reaches the 2-of-3 threshold but is never executed.
    ts::next_tx(&mut s, ALICE);
    let id = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            50_000_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        id
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id, true, &c, ts::ctx(&mut s));
        assert!(pw::request_threshold_reached_at(&wallet, id) > 0);
        ts::return_shared(wallet);
    };

    // Execution window (spend timelock + expiry) lapses.
    c.increment_for_testing(HOUR_MS + DAY_MS + 2);

    // Carol never voted; her late vote expires the request instead of counting.
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id, true, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, id) == 4); // expired
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}
