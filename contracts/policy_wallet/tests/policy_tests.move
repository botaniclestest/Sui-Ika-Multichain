// Mythos Policy Wallet - governance & vault lifecycle tests
// SPDX-License-Identifier: BSD-3-Clause-Clear
#[test_only]
module policy_wallet::policy_tests;

use policy_wallet::policy_wallet::{Self as pw, PolicyWallet};
use policy_wallet::registry::{Self, Registry};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const MALLORY: address = @0xBAD;
const RECIPIENT: address = @0x123456;

const VAULT_CHAIN: vector<u8> = b"sui:vault";
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

// fast=1 SUI, per-tx=100 SUI, window=150 SUI/day, fee n/a
const FAST: u128 = 1_000_000_000;
const PER_TX: u128 = 100_000_000_000;
const WINDOW: u128 = 150_000_000_000;

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
            0, // evm chain id
            FAST,
            PER_TX,
            WINDOW,
            DAY_MS,
            0, // fee limit (n/a for vault)
            false, // allowlist
            false, // allow_unverified
            ts::ctx(scenario),
        );
        pw::finalize_setup(&mut wallet, ts::ctx(scenario));
        // fund the vault with 200 SUI
        let funds = coin::mint_for_testing<SUI>(200_000_000_000, ts::ctx(scenario));
        pw::vault_deposit(&mut wallet, funds);
        ts::return_shared(wallet);
    };

    let mut c = clock::create_for_testing(ts::ctx(scenario));
    c.set_for_testing(1_000_000);
    c
}

fun sui_type_bytes(): vector<u8> {
    b"0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
}

fun dest_bytes(): vector<u8> {
    sui::address::to_bytes(RECIPIENT)
}

// === Lifecycle: 2-of-3 + timelock + execution ===

#[test]
fun vault_spend_full_lifecycle() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // Alice creates a 50 SUI request (above fast path).
    ts::next_tx(&mut s, ALICE);
    let request_id = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            50_000_000_000, &c, ts::ctx(&mut s),
        );
        assert!(pw::request_approvals(&wallet, id) == 1);
        assert!(pw::request_threshold_reached_at(&wallet, id) == 0);
        ts::return_shared(wallet);
        id
    };

    // Bob approves -> threshold reached, timelock starts.
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, request_id, true, &c, ts::ctx(&mut s));
        assert!(pw::request_threshold_reached_at(&wallet, request_id) > 0);
        ts::return_shared(wallet);
    };

    // After the timelock, anyone in the signer set executes.
    c.increment_for_testing(HOUR_MS + 1);
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::execute_vault_spend<SUI>(&mut wallet, request_id, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, request_id) == 1); // executed
        assert!(pw::chain_spent_in_window(&wallet, VAULT_CHAIN) == 50_000_000_000);
        assert!(pw::vault_balance_for_testing<SUI>(&wallet) == 150_000_000_000);
        ts::return_shared(wallet);
    };

    // Recipient received the coin.
    ts::next_tx(&mut s, RECIPIENT);
    {
        let received = ts::take_from_address<coin::Coin<SUI>>(&s, RECIPIENT);
        assert!(received.value() == 50_000_000_000);
        ts::return_to_address(RECIPIENT, received);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = pw::ETimelockActive)]
fun vault_spend_blocked_by_timelock() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    let request_id = {
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
        pw::vote_spend(&mut wallet, request_id, true, &c, ts::ctx(&mut s));
        // immediate execution must fail: timelock not elapsed
        pw::execute_vault_spend<SUI>(&mut wallet, request_id, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
fun fast_path_small_amount_single_approval_no_timelock() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            500_000_000, // 0.5 SUI <= fast path limit
            &c, ts::ctx(&mut s),
        );
        // creator's auto-approval reaches the fast-path threshold immediately
        assert!(pw::request_threshold_reached_at(&wallet, id) > 0);
        // and executes with no timelock
        pw::execute_vault_spend<SUI>(&mut wallet, id, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, id) == 1);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

#[test]
#[expected_failure(abort_code = pw::EThresholdNotReached)]
fun rejection_disables_fast_path() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    let id = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            500_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        id
    };
    // Bob rejects -> fast path dead; 1 approval is no longer enough.
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id, false, &c, ts::ctx(&mut s));
        pw::execute_vault_spend<SUI>(&mut wallet, id, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::EOverPerTxLimit)]
fun per_tx_limit_enforced() {
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

#[test]
#[expected_failure(abort_code = pw::EOverWindowLimit)]
fun window_limit_enforced() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // First 100 SUI spend executes fine.
    ts::next_tx(&mut s, ALICE);
    let id1 = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            100_000_000_000, &c, ts::ctx(&mut s),
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
        pw::execute_vault_spend<SUI>(&mut wallet, id1, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };

    // Second 100 SUI spend in the same window busts the 150 SUI cap.
    ts::next_tx(&mut s, ALICE);
    let id2 = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            100_000_000_000, &c, ts::ctx(&mut s),
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
        pw::execute_vault_spend<SUI>(&mut wallet, id2, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::ENotSigner)]
fun non_signer_cannot_create_request() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);
    ts::next_tx(&mut s, MALLORY);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            500_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::EAlreadyVoted)]
fun double_vote_rejected() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let id = pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            50_000_000_000, &c, ts::ctx(&mut s),
        );
        // creator already auto-approved
        pw::vote_spend(&mut wallet, id, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
fun request_expires() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
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
    c.increment_for_testing(DAY_MS + 1);
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_spend(&mut wallet, id, true, &c, ts::ctx(&mut s));
        assert!(pw::request_status(&wallet, id) == 4); // expired
        ts::return_shared(wallet);
    };
    c.destroy_for_testing();
    ts::end(s);
}

// === Pause / unpause ===

#[test]
#[expected_failure(abort_code = pw::EPaused)]
fun pause_blocks_new_requests() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::pause(&mut wallet, ts::ctx(&mut s));
        assert!(pw::is_paused(&wallet));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            500_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
fun unpause_requires_admin_proposal() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::pause(&mut wallet, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };

    // Unpause proposal: needs admin threshold (3-of-3) + admin timelock.
    ts::next_tx(&mut s, ALICE);
    let pid = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid = pw::create_proposal(
            &mut wallet,
            11, // ACTION_UNPAUSE
            vector::empty(),
            option::none(),
            vector::empty(),
            vector::empty(),
            false,
            &c,
            ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let mut reg = ts::take_shared<Registry>(&s);
        pw::execute_proposal(&mut wallet, &mut reg, pid, &c, ts::ctx(&mut s));
        assert!(!pw::is_paused(&wallet));
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

// === Signer rotation ===

#[test]
#[expected_failure(abort_code = pw::EBadThreshold)]
fun invalid_threshold_proposal_rejected_at_creation() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_proposal(
            &mut wallet,
            3, // SET_THRESHOLDS
            vector::empty(),
            option::none(),
            vector::empty(),
            vector[2, 1], // admin threshold cannot be below spend threshold
            false,
            &c,
            ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
#[expected_failure(abort_code = pw::EBadThreshold)]
fun impossible_remove_signer_proposal_rejected_at_creation() {
    let mut s = ts::begin(ALICE);
    let c = setup(&mut s);

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_proposal(
            &mut wallet,
            2, // REMOVE_SIGNER
            vector::empty(),
            option::some(BOB),
            vector::empty(),
            vector::empty(),
            false,
            &c,
            ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}

#[test]
fun add_and_remove_signer_via_proposals() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);
    let dave: address = @0xDA4E;

    // Add Dave.
    ts::next_tx(&mut s, ALICE);
    let pid = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid = pw::create_proposal(
            &mut wallet, 1 /* ADD_SIGNER */, vector::empty(),
            option::some(dave), vector::empty(), vector::empty(), false,
            &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let mut reg = ts::take_shared<Registry>(&s);
        pw::execute_proposal(&mut wallet, &mut reg, pid, &c, ts::ctx(&mut s));
        assert!(pw::is_signer(&wallet, dave));
        assert!(pw::signers(&wallet).length() == 4);
        // registry knows about Dave's membership
        assert!(registry::wallets_of(&reg, dave).length() == 1);
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };

    // Remove Bob (4 signers, admin threshold 3 still satisfiable).
    ts::next_tx(&mut s, ALICE);
    let pid2 = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid2 = pw::create_proposal(
            &mut wallet, 2 /* REMOVE_SIGNER */, vector::empty(),
            option::some(BOB), vector::empty(), vector::empty(), false,
            &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid2
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid2, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, dave);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid2, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let mut reg = ts::take_shared<Registry>(&s);
        pw::execute_proposal(&mut wallet, &mut reg, pid2, &c, ts::ctx(&mut s));
        assert!(!pw::is_signer(&wallet, BOB));
        assert!(registry::wallets_of(&reg, BOB).is_empty());
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };

    c.destroy_for_testing();
    ts::end(s);
}

// === Allowlist via proposal ===

#[test]
#[expected_failure(abort_code = pw::EDestinationNotAllowed)]
fun allowlist_blocks_unlisted_destination() {
    let mut s = ts::begin(ALICE);
    let mut c = setup(&mut s);

    // Enable the allowlist (empty) via proposal: every destination is blocked.
    ts::next_tx(&mut s, ALICE);
    let pid = {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let pid = pw::create_proposal(
            &mut wallet, 14 /* SET_ALLOWLIST_ENABLED */, VAULT_CHAIN,
            option::none(), vector::empty(), vector::empty(), true,
            &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
        pid
    };
    ts::next_tx(&mut s, BOB);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    ts::next_tx(&mut s, CAROL);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::vote_proposal(&mut wallet, pid, true, &c, ts::ctx(&mut s));
        ts::return_shared(wallet);
    };
    c.increment_for_testing(2 * HOUR_MS + 1);
    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        let mut reg = ts::take_shared<Registry>(&s);
        pw::execute_proposal(&mut wallet, &mut reg, pid, &c, ts::ctx(&mut s));
        ts::return_shared(reg);
        ts::return_shared(wallet);
    };

    ts::next_tx(&mut s, ALICE);
    {
        let mut wallet = ts::take_shared<PolicyWallet>(&s);
        pw::create_vault_spend_request(
            &mut wallet, VAULT_CHAIN, sui_type_bytes(), dest_bytes(),
            500_000_000, &c, ts::ctx(&mut s),
        );
        ts::return_shared(wallet);
    };
    abort 0
}
