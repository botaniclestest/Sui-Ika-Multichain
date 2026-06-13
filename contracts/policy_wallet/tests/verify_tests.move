// Mythos Policy Wallet - intent verifier tests
// SPDX-License-Identifier: BSD-3-Clause-Clear
#[test_only]
module policy_wallet::verify_tests;

use policy_wallet::verify_btc;
use policy_wallet::verify_evm;
use policy_wallet::verify_solana;
use std::hash;

// === helpers ===

fun u64_le(v: u64): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i: u8 = 0;
    while (i < 8) {
        out.push_back(((v >> (i * 8)) & 0xff) as u8);
        i = i + 1;
    };
    out
}

fun u32_le(v: u32): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i: u8 = 0;
    while (i < 4) {
        out.push_back(((v >> (i * 8)) & 0xff) as u8);
        i = i + 1;
    };
    out
}

fun repeat(byte: u8, n: u64): vector<u8> {
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < n) {
        out.push_back(byte);
        i = i + 1;
    };
    out
}

fun dsha256(bytes: vector<u8>): vector<u8> {
    hash::sha2_256(hash::sha2_256(bytes))
}

fun own_script(): vector<u8> {
    let mut s = vector[0x00u8, 0x14];
    s.append(repeat(0xAA, 20));
    s
}

fun dest_script(): vector<u8> {
    let mut s = vector[0x00u8, 0x14];
    s.append(repeat(0xBB, 20));
    s
}

fun script_code_for_own(): vector<u8> {
    // 0x19 76 a9 14 <own pkh> 88 ac
    let mut sc = vector[0x19u8, 0x76, 0xa9, 0x14];
    sc.append(repeat(0xAA, 20));
    sc.push_back(0x88);
    sc.push_back(0xac);
    sc
}

/// Serialized output: value || varint(len) || script
fun output_bytes(value: u64, script: vector<u8>): vector<u8> {
    let mut out = u64_le(value);
    out.push_back(script.length() as u8);
    out.append(script);
    out
}

fun build_preimage(
    prevouts: &vector<u8>,
    input_index: u64,
    input_amount: u64,
    outputs_bytes: &vector<u8>,
    sighash_type: u32,
): vector<u8> {
    let mut p = u32_le(2); // version
    p.append(dsha256(*prevouts)); // hashPrevouts
    p.append(repeat(0xCC, 32)); // hashSequence (opaque to verifier consistency across inputs)
    // outpoint = prevouts[36*idx..]
    let mut i = 0;
    while (i < 36) {
        p.push_back(prevouts[input_index * 36 + i]);
        i = i + 1;
    };
    p.append(script_code_for_own());
    p.append(u64_le(input_amount));
    p.append(u32_le(0xfffffffd)); // sequence
    p.append(dsha256(*outputs_bytes)); // hashOutputs
    p.append(u32_le(0)); // locktime
    p.append(u32_le(sighash_type));
    p
}

fun single_prevout(): vector<u8> {
    let mut prevouts = repeat(0x01, 32); // txid
    prevouts.append(u32_le(0)); // vout
    prevouts
}

// === BTC tests ===

#[test]
fun btc_valid_single_input_with_change() {
    let prevouts = single_prevout();
    let mut outputs = output_bytes(90_000, dest_script());
    outputs.append(output_bytes(9_000, own_script())); // change back to self
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    // fee = 100000 - 99000 = 1000
    verify_btc::verify(
        &vector[preimage],
        &outputs,
        &prevouts,
        &own_script(),
        &dest_script(),
        90_000,
        2_000,
    );
}

#[test]
fun btc_valid_two_inputs() {
    let mut prevouts = single_prevout();
    prevouts.append(repeat(0x02, 32));
    prevouts.append(u32_le(1));
    let outputs = output_bytes(150_000, dest_script());
    let p0 = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    let p1 = build_preimage(&prevouts, 1, 60_000, &outputs, 1);
    verify_btc::verify(
        &vector[p0, p1],
        &outputs,
        &prevouts,
        &own_script(),
        &dest_script(),
        150_000,
        20_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EDestinationMismatch)]
fun btc_rejects_wrong_destination() {
    let prevouts = single_prevout();
    let mut wrong = vector[0x00u8, 0x14];
    wrong.append(repeat(0xDD, 20));
    let outputs = output_bytes(90_000, wrong);
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    verify_btc::verify(
        &vector[preimage], &outputs, &prevouts, &own_script(), &dest_script(), 90_000, 20_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EAmountMismatch)]
fun btc_rejects_wrong_amount() {
    let prevouts = single_prevout();
    let outputs = output_bytes(95_000, dest_script());
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    verify_btc::verify(
        &vector[preimage], &outputs, &prevouts, &own_script(), &dest_script(), 90_000, 20_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::ESighashNotAll)]
fun btc_rejects_sighash_single() {
    let prevouts = single_prevout();
    let outputs = output_bytes(90_000, dest_script());
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 3); // SIGHASH_SINGLE
    verify_btc::verify(
        &vector[preimage], &outputs, &prevouts, &own_script(), &dest_script(), 90_000, 20_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EFeeTooHigh)]
fun btc_rejects_excessive_fee() {
    let prevouts = single_prevout();
    let outputs = output_bytes(50_000, dest_script());
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    // fee = 50_000 > limit 2_000
    verify_btc::verify(
        &vector[preimage], &outputs, &prevouts, &own_script(), &dest_script(), 50_000, 2_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EChangeNotSelf)]
fun btc_rejects_change_to_third_party() {
    let prevouts = single_prevout();
    let mut thief = vector[0x00u8, 0x14];
    thief.append(repeat(0xDD, 20));
    let mut outputs = output_bytes(90_000, dest_script());
    outputs.append(output_bytes(9_000, thief));
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs, 1);
    verify_btc::verify(
        &vector[preimage], &outputs, &prevouts, &own_script(), &dest_script(), 90_000, 2_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EOutputsMismatch)]
fun btc_rejects_outputs_substitution() {
    let prevouts = single_prevout();
    let outputs_real = output_bytes(90_000, dest_script());
    // preimage commits to different outputs than the ones supplied
    let outputs_lied = output_bytes(90_000, own_script());
    let preimage = build_preimage(&prevouts, 0, 100_000, &outputs_lied, 1);
    verify_btc::verify(
        &vector[preimage], &outputs_real, &prevouts, &own_script(), &dest_script(), 90_000, 20_000,
    );
}

#[test]
#[expected_failure(abort_code = verify_btc::EScriptCodeMismatch)]
fun btc_rejects_foreign_input() {
    // scriptCode bound to someone else's pubkey hash
    let prevouts = single_prevout();
    let outputs = output_bytes(90_000, dest_script());
    let mut p = u32_le(2);
    p.append(dsha256(prevouts));
    p.append(repeat(0xCC, 32));
    let mut i = 0;
    while (i < 36) { p.push_back(prevouts[i]); i = i + 1; };
    let mut foreign_sc = vector[0x19u8, 0x76, 0xa9, 0x14];
    foreign_sc.append(repeat(0xEE, 20));
    foreign_sc.push_back(0x88);
    foreign_sc.push_back(0xac);
    p.append(foreign_sc);
    p.append(u64_le(100_000));
    p.append(u32_le(0xfffffffd));
    p.append(dsha256(outputs));
    p.append(u32_le(0));
    p.append(u32_le(1));
    verify_btc::verify(
        &vector[p], &outputs, &prevouts, &own_script(), &dest_script(), 90_000, 20_000,
    );
}

// === EVM helpers ===

fun rlp_scalar(v: u128): vector<u8> {
    if (v == 0) return vector[0x80u8];
    // big-endian minimal bytes
    let mut tmp = v;
    let mut be = vector::empty<u8>();
    while (tmp > 0) {
        be.push_back((tmp & 0xff) as u8);
        tmp = tmp >> 8;
    };
    be.reverse();
    if (be.length() == 1 && be[0] < 0x80) {
        be
    } else {
        let mut out = vector[(0x80 + be.length()) as u8];
        out.append(be);
        out
    }
}

fun rlp_bytes(bytes: vector<u8>): vector<u8> {
    if (bytes.length() == 1 && bytes[0] < 0x80) return bytes;
    if (bytes.length() <= 55) {
        let mut out = vector[(0x80 + bytes.length()) as u8];
        out.append(bytes);
        out
    } else {
        // single-byte length is enough for our tests
        let mut out = vector[0xb8u8, bytes.length() as u8];
        out.append(bytes);
        out
    }
}

fun build_eip1559(
    chain_id: u128,
    nonce: u128,
    max_priority: u128,
    max_fee: u128,
    gas: u128,
    to: vector<u8>,
    value: u128,
    data: vector<u8>,
): vector<u8> {
    let mut payload = rlp_scalar(chain_id);
    payload.append(rlp_scalar(nonce));
    payload.append(rlp_scalar(max_priority));
    payload.append(rlp_scalar(max_fee));
    payload.append(rlp_scalar(gas));
    payload.append(rlp_bytes(to));
    payload.append(rlp_scalar(value));
    payload.append(rlp_bytes(data));
    payload.push_back(0xc0); // empty access list
    let mut msg = vector[0x02u8];
    if (payload.length() <= 55) {
        msg.push_back((0xc0 + payload.length()) as u8);
    } else {
        msg.push_back(0xf8);
        msg.push_back(payload.length() as u8);
    };
    msg.append(payload);
    msg
}

fun evm_dest(): vector<u8> { repeat(0xBB, 20) }

fun erc20_transfer_data(dest: vector<u8>, amount: u128): vector<u8> {
    let mut data = vector[0xa9u8, 0x05, 0x9c, 0xbb];
    data.append(repeat(0x00, 12));
    data.append(dest);
    data.append(repeat(0x00, 16));
    // big-endian u128, full 16 bytes
    let mut i: u8 = 16;
    while (i > 0) {
        i = i - 1;
        data.push_back(((amount >> (i * 8)) & 0xff) as u8);
    };
    data
}

// === EVM tests ===

#[test]
fun evm_valid_native_transfer() {
    let msg = build_eip1559(
        8453, 7, 1_000_000_000, 2_000_000_000, 21_000,
        evm_dest(), 1_000_000_000_000_000, vector::empty(),
    );
    verify_evm::verify(
        &msg, 8453, &vector::empty(), &evm_dest(), 1_000_000_000_000_000,
        2_000_000_000 * 21_000,
    );
}

#[test]
fun evm_valid_erc20_transfer() {
    let token = repeat(0xDD, 20);
    let data = erc20_transfer_data(evm_dest(), 5_000_000);
    let msg = build_eip1559(1, 0, 1, 2, 60_000, token, 0, data);
    verify_evm::verify(&msg, 1, &repeat(0xDD, 20), &evm_dest(), 5_000_000, 120_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::EChainIdMismatch)]
fun evm_rejects_cross_chain_replay() {
    let msg = build_eip1559(1, 0, 1, 2, 21_000, evm_dest(), 100, vector::empty());
    verify_evm::verify(&msg, 8453, &vector::empty(), &evm_dest(), 100, 42_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::EDestinationMismatch)]
fun evm_rejects_wrong_recipient() {
    let msg = build_eip1559(1, 0, 1, 2, 21_000, repeat(0xEE, 20), 100, vector::empty());
    verify_evm::verify(&msg, 1, &vector::empty(), &evm_dest(), 100, 42_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::EAmountMismatch)]
fun evm_rejects_wrong_amount() {
    let msg = build_eip1559(1, 0, 1, 2, 21_000, evm_dest(), 101, vector::empty());
    verify_evm::verify(&msg, 1, &vector::empty(), &evm_dest(), 100, 42_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::ECalldataNotTransfer)]
fun evm_rejects_arbitrary_calldata_on_native() {
    let msg = build_eip1559(1, 0, 1, 2, 50_000, evm_dest(), 100, vector[0xde, 0xad]);
    verify_evm::verify(&msg, 1, &vector::empty(), &evm_dest(), 100, 100_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::EFeeTooHigh)]
fun evm_rejects_excessive_gas() {
    let msg = build_eip1559(1, 0, 1, 1_000_000_000_000, 10_000_000, evm_dest(), 100, vector::empty());
    verify_evm::verify(&msg, 1, &vector::empty(), &evm_dest(), 100, 42_000);
}

#[test]
#[expected_failure(abort_code = verify_evm::EValueNotZero)]
fun evm_rejects_erc20_with_eth_value() {
    let token = repeat(0xDD, 20);
    let data = erc20_transfer_data(evm_dest(), 5_000_000);
    let msg = build_eip1559(1, 0, 1, 2, 60_000, token, 999, data);
    verify_evm::verify(&msg, 1, &repeat(0xDD, 20), &evm_dest(), 5_000_000, 120_000);
}

// === Solana helpers ===

fun sol_own(): vector<u8> { repeat(0xAA, 32) }

fun sol_dest(): vector<u8> { repeat(0xBB, 32) }

fun build_sol_transfer(
    own: vector<u8>,
    dest: vector<u8>,
    lamports: u64,
    from_index: u8,
    program_index: u8,
): vector<u8> {
    let mut m = vector[1u8, 0, 1]; // header
    m.push_back(3); // 3 accounts (shortvec, fits one byte)
    m.append(own);
    m.append(dest);
    m.append(repeat(0x00, 32)); // system program
    m.append(repeat(0xEE, 32)); // recent blockhash
    m.push_back(1); // 1 instruction
    m.push_back(program_index);
    m.push_back(2); // 2 account indexes
    m.push_back(from_index);
    m.push_back(1); // to index
    m.push_back(12); // data length
    m.append(u32_le(2)); // SystemInstruction::Transfer
    m.append(u64_le(lamports));
    m
}

fun build_sol_transfer_duplicate_own_source(): vector<u8> {
    let mut m = vector[1u8, 0, 1];
    m.push_back(4); // [own signer, dest, duplicate own, system]
    m.append(sol_own());
    m.append(sol_dest());
    m.append(sol_own());
    m.append(repeat(0x00, 32));
    m.append(repeat(0xEE, 32));
    m.push_back(1);
    m.push_back(3); // system program
    m.push_back(2);
    m.push_back(2); // duplicate own, but not the signer index
    m.push_back(1);
    m.push_back(12);
    m.append(u32_le(2));
    m.append(u64_le(1_000_000));
    m
}

// === Solana tests ===

#[test]
fun sol_valid_transfer() {
    let msg = build_sol_transfer(sol_own(), sol_dest(), 1_000_000, 0, 2);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::ESourceNotSelf)]
fun sol_rejects_foreign_source() {
    let msg = build_sol_transfer(repeat(0xDD, 32), sol_dest(), 1_000_000, 0, 2);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::ESourceNotSelf)]
fun sol_rejects_duplicate_non_signer_source() {
    let msg = build_sol_transfer_duplicate_own_source();
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EDestinationMismatch)]
fun sol_rejects_wrong_destination() {
    let msg = build_sol_transfer(sol_own(), repeat(0xDD, 32), 1_000_000, 0, 2);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EAmountMismatch)]
fun sol_rejects_wrong_amount() {
    let msg = build_sol_transfer(sol_own(), sol_dest(), 999, 0, 2);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::ENotSystemTransfer)]
fun sol_rejects_non_system_program() {
    // program index points at dest (non-zero key)
    let msg = build_sol_transfer(sol_own(), sol_dest(), 1_000_000, 0, 1);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EVersionedMessage)]
fun sol_rejects_versioned_message() {
    let mut msg = build_sol_transfer(sol_own(), sol_dest(), 1_000_000, 0, 2);
    *msg.borrow_mut(0) = 0x81; // v0 message marker
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 1_000_000);
}

// === Solana durable-nonce tests ===

fun sysvar_recent_blockhashes(): vector<u8> {
    x"06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000"
}

/// accounts: [own(signer), dest, nonce, sysvar, system]
/// ix0: nonceAdvance(nonce=2, sysvar=3, auth=0); ix1: transfer(0 -> 1)
fun build_sol_durable_transfer(
    own: vector<u8>,
    dest: vector<u8>,
    lamports: u64,
    auth_index: u8,
): vector<u8> {
    let mut m = vector[1u8, 0, 2]; // header: 1 signer, 0 ro-signed, 2 ro-unsigned
    m.push_back(5); // 5 accounts
    m.append(own);
    m.append(dest);
    m.append(repeat(0xCD, 32)); // nonce account
    m.append(sysvar_recent_blockhashes());
    m.append(repeat(0x00, 32)); // system program
    m.append(repeat(0xEE, 32)); // nonce value in blockhash slot
    m.push_back(2); // 2 instructions
    // ix0: advance nonce
    m.push_back(4); // program index (system)
    m.push_back(3); // 3 accounts
    m.push_back(2); // nonce
    m.push_back(3); // sysvar
    m.push_back(auth_index); // authority
    m.push_back(4); // data len
    m.append(u32_le(4)); // AdvanceNonceAccount
    // ix1: transfer
    m.push_back(4); // program index
    m.push_back(2); // 2 accounts
    m.push_back(0); // from
    m.push_back(1); // to
    m.push_back(12); // data len
    m.append(u32_le(2));
    m.append(u64_le(lamports));
    m
}

fun build_sol_durable_duplicate_authority(): vector<u8> {
    let mut m = vector[1u8, 0, 2];
    m.push_back(6); // [own signer, dest, duplicate own, nonce, sysvar, system]
    m.append(sol_own());
    m.append(sol_dest());
    m.append(sol_own());
    m.append(repeat(0xCD, 32));
    m.append(sysvar_recent_blockhashes());
    m.append(repeat(0x00, 32));
    m.append(repeat(0xEE, 32));
    m.push_back(2);
    m.push_back(5); // system program
    m.push_back(3);
    m.push_back(3); // nonce
    m.push_back(4); // sysvar
    m.push_back(2); // duplicate own, but not the signer index
    m.push_back(4);
    m.append(u32_le(4));
    m.push_back(5); // system program
    m.push_back(2);
    m.push_back(0); // transfer source is still the signer
    m.push_back(1);
    m.push_back(12);
    m.append(u32_le(2));
    m.append(u64_le(50_000_000));
    m
}

#[test]
fun sol_valid_durable_nonce_transfer() {
    let msg = build_sol_durable_transfer(sol_own(), sol_dest(), 50_000_000, 0);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 50_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EBadNonceAdvance)]
fun sol_rejects_foreign_nonce_authority() {
    // authority index points at dest, not the wallet
    let msg = build_sol_durable_transfer(sol_own(), sol_dest(), 50_000_000, 1);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 50_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EBadNonceAdvance)]
fun sol_rejects_duplicate_non_signer_nonce_authority() {
    let msg = build_sol_durable_duplicate_authority();
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 50_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EAmountMismatch)]
fun sol_durable_rejects_wrong_amount() {
    let msg = build_sol_durable_transfer(sol_own(), sol_dest(), 50_000_001, 0);
    verify_solana::verify(&msg, &sol_own(), &sol_dest(), 50_000_000);
}

#[test]
#[expected_failure(abort_code = verify_solana::EBadNonceAdvance)]
fun sol_durable_rejects_fake_sysvar() {
    let mut m = vector[1u8, 0, 2];
    m.push_back(5);
    m.append(sol_own());
    m.append(sol_dest());
    m.append(repeat(0xCD, 32));
    m.append(repeat(0xAB, 32)); // NOT the recent-blockhashes sysvar
    m.append(repeat(0x00, 32));
    m.append(repeat(0xEE, 32));
    m.push_back(2);
    m.push_back(4);
    m.push_back(3);
    m.push_back(2);
    m.push_back(3);
    m.push_back(0);
    m.push_back(4);
    m.append(u32_le(4));
    m.push_back(4);
    m.push_back(2);
    m.push_back(0);
    m.push_back(1);
    m.push_back(12);
    m.append(u32_le(2));
    m.append(u64_le(50_000_000));
    verify_solana::verify(&m, &sol_own(), &sol_dest(), 50_000_000);
}
