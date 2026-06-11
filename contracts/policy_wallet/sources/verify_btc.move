// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// On-chain verification of Bitcoin spend intents.
///
/// A BTC spend request supplies one BIP-143 (segwit v0, P2WPKH) sighash
/// preimage per input, plus the serialized outputs and prevouts. This module
/// proves, entirely on-chain, that the bytes Ika will sign:
///   * spend only this wallet's UTXOs (scriptCode is bound to the wallet's
///     own pubkey hash),
///   * pay exactly `amount` to exactly `destination_script`,
///   * send any change only back to the wallet itself,
///   * pay a miner fee within the configured limit,
///   * use SIGHASH_ALL (no malleable partial-commitment sighash types).
///
/// Because hashOutputs/hashPrevouts are recomputed from the supplied
/// serializations and compared against every preimage, a request cannot lie
/// about where funds go: the signature produced from these preimages is only
/// valid for the transaction whose outputs were verified here.
module policy_wallet::verify_btc;

use policy_wallet::reader;
use std::hash;

const ESighashNotAll: u64 = 0;
const EPreimageMalformed: u64 = 1;
const EPreimageMismatch: u64 = 2;
const EPrevoutsMismatch: u64 = 3;
const EOutputsMismatch: u64 = 4;
const EBadOutputCount: u64 = 5;
const EDestinationMismatch: u64 = 6;
const EAmountMismatch: u64 = 7;
const EChangeNotSelf: u64 = 8;
const EFeeTooHigh: u64 = 9;
const EOwnScriptMalformed: u64 = 10;
const EScriptCodeMismatch: u64 = 11;
const ENoInputs: u64 = 12;
const EValueOverflow: u64 = 13;

const SIGHASH_ALL: u32 = 1;
/// Maximum total input value we accept (21M BTC in sats) - overflow guard.
const MAX_SATS: u64 = 21_000_000_0000_0000;

fun dsha256(bytes: vector<u8>): vector<u8> {
    hash::sha2_256(hash::sha2_256(bytes))
}

/// Verifies a BTC spend intent. Aborts unless every check passes.
///
/// * `preimages`     - one BIP-143 preimage per input, in input order.
/// * `outputs_bytes` - serialization of all outputs (value || varint || script)*
/// * `prevouts_bytes`- concatenation of all 36-byte outpoints, in input order.
/// * `own_script`    - this wallet's P2WPKH scriptPubKey (0x0014 || pkh20).
/// * `destination_script` - scriptPubKey of the declared destination.
/// * `amount`        - declared amount in sats that must go to destination.
/// * `fee_limit`     - maximum allowed miner fee in sats.
public(package) fun verify(
    preimages: &vector<vector<u8>>,
    outputs_bytes: &vector<u8>,
    prevouts_bytes: &vector<u8>,
    own_script: &vector<u8>,
    destination_script: &vector<u8>,
    amount: u128,
    fee_limit: u128,
) {
    let n_inputs = preimages.length();
    assert!(n_inputs > 0, ENoInputs);

    // own_script must be canonical P2WPKH: OP_0 PUSH20 <pkh>
    assert!(
        own_script.length() == 22 && own_script[0] == 0x00 && own_script[1] == 0x14,
        EOwnScriptMalformed,
    );
    // Expected scriptCode for our inputs: 0x19 76 a9 14 <pkh20> 88 ac
    let mut expected_script_code = vector[0x19u8, 0x76, 0xa9, 0x14];
    let mut i = 0;
    while (i < 20) {
        expected_script_code.push_back(own_script[2 + i]);
        i = i + 1;
    };
    expected_script_code.push_back(0x88);
    expected_script_code.push_back(0xac);

    // Prevouts serialization must be exactly N * 36 bytes.
    assert!(prevouts_bytes.length() == n_inputs * 36, EPrevoutsMismatch);
    let hash_prevouts_expected = dsha256(*prevouts_bytes);
    let hash_outputs_expected = dsha256(*outputs_bytes);

    let mut shared_hash_sequence: vector<u8> = vector::empty();
    let mut shared_version: u32 = 0;
    let mut shared_locktime: u32 = 0;
    let mut total_in: u64 = 0;

    let mut idx = 0;
    while (idx < n_inputs) {
        let mut r = reader::new(*preimages.borrow(idx));
        let version = r.read_u32_le();
        let hash_prevouts = r.read_bytes(32);
        let hash_sequence = r.read_bytes(32);
        let outpoint = r.read_bytes(36);
        let script_code_len = r.read_btc_varint();
        // 0x19 = 25-byte P2PKH-style scriptCode for P2WPKH.
        assert!(script_code_len == 25, EScriptCodeMismatch);
        let mut script_code = vector[0x19u8];
        script_code.append(r.read_bytes(25));
        let input_amount = r.read_u64_le();
        let _sequence = r.read_u32_le();
        let hash_outputs = r.read_bytes(32);
        let locktime = r.read_u32_le();
        let sighash_type = r.read_u32_le();
        assert!(r.is_empty(), EPreimageMalformed);

        assert!(sighash_type == SIGHASH_ALL, ESighashNotAll);
        assert!(script_code == expected_script_code, EScriptCodeMismatch);
        assert!(hash_prevouts == hash_prevouts_expected, EPrevoutsMismatch);
        assert!(hash_outputs == hash_outputs_expected, EOutputsMismatch);
        // Each preimage's outpoint must match the prevout at its index, which
        // (with the hashPrevouts equality) proves there are exactly N inputs
        // and we are signing all of them.
        let expected_outpoint = reader::slice(prevouts_bytes, idx * 36, 36);
        assert!(outpoint == expected_outpoint, EPrevoutsMismatch);

        if (idx == 0) {
            shared_hash_sequence = hash_sequence;
            shared_version = version;
            shared_locktime = locktime;
        } else {
            assert!(hash_sequence == shared_hash_sequence, EPreimageMismatch);
            assert!(version == shared_version, EPreimageMismatch);
            assert!(locktime == shared_locktime, EPreimageMismatch);
        };

        assert!(input_amount <= MAX_SATS, EValueOverflow);
        total_in = total_in + input_amount;
        assert!(total_in <= MAX_SATS, EValueOverflow);
        idx = idx + 1;
    };

    // Parse outputs: (value u64 LE || varint script_len || script)*
    let mut out_reader = reader::new(*outputs_bytes);
    let mut total_out: u64 = 0;
    let mut n_outputs: u64 = 0;
    while (!out_reader.is_empty()) {
        let value = out_reader.read_u64_le();
        let script_len = out_reader.read_btc_varint();
        let script = out_reader.read_bytes(script_len);
        if (n_outputs == 0) {
            // First output: must be the declared destination and amount.
            assert!(&script == destination_script, EDestinationMismatch);
            assert!((value as u128) == amount, EAmountMismatch);
        } else {
            // Any further output must be change back to this wallet.
            assert!(&script == own_script, EChangeNotSelf);
        };
        assert!(value <= MAX_SATS, EValueOverflow);
        total_out = total_out + value;
        assert!(total_out <= MAX_SATS, EValueOverflow);
        n_outputs = n_outputs + 1;
    };
    assert!(n_outputs >= 1 && n_outputs <= 2, EBadOutputCount);

    // Fee check: inputs must cover outputs; fee bounded by policy.
    assert!(total_in >= total_out, EFeeTooHigh);
    let fee = ((total_in - total_out) as u128);
    assert!(fee <= fee_limit, EFeeTooHigh);
}
