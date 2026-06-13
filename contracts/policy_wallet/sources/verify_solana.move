// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// On-chain verification of Solana spend intents.
///
/// The message Ika signs for Solana is the exact serialized legacy message
/// (EdDSA over the message bytes). This module parses that message and proves
/// it is a single SystemProgram::Transfer that:
///   * is fee-paid and signed by this wallet's Solana account only,
///   * moves exactly `amount` lamports to `destination`,
///   * contains no other instructions.
///
/// Versioned (v0) messages and SPL token transfers are NOT verifiable here;
/// they must go through the unverified-intent path, which is subject to the
/// stricter policy rules (full threshold + timelock, allow_unverified flag).
module policy_wallet::verify_solana;

use policy_wallet::reader;

const EVersionedMessage: u64 = 0;
const EMalformed: u64 = 1;
const ENotSingleInstruction: u64 = 2;
const ENotSystemTransfer: u64 = 3;
const ESourceNotSelf: u64 = 4;
const EDestinationMismatch: u64 = 5;
const EAmountMismatch: u64 = 6;
const EBadHeader: u64 = 7;

/// Verifies a Solana spend intent. Aborts unless every check passes.
///
/// * `message`     - serialized legacy Solana message bytes.
/// * `own_pubkey`  - this wallet's ed25519 public key (32 bytes).
/// * `destination` - declared 32-byte recipient public key.
/// * `amount`      - declared lamports.
public(package) fun verify(
    message: &vector<u8>,
    own_pubkey: &vector<u8>,
    destination: &vector<u8>,
    amount: u128,
) {
    assert!(own_pubkey.length() == 32, EMalformed);
    assert!(destination.length() == 32, EDestinationMismatch);

    let mut r = reader::new(*message);

    let num_required_signatures = r.read_u8();
    // Versioned messages set the top bit of the first byte.
    assert!(num_required_signatures & 0x80 == 0, EVersionedMessage);
    // Exactly one signer: the wallet itself. This prevents smuggling in
    // co-signed instructions.
    assert!(num_required_signatures == 1, EBadHeader);
    let _num_readonly_signed = r.read_u8();
    let _num_readonly_unsigned = r.read_u8();

    let n_accounts = r.read_shortvec_len();
    assert!(n_accounts >= 2 && n_accounts <= 16, EMalformed);
    let mut accounts: vector<vector<u8>> = vector::empty();
    let mut i = 0;
    while (i < n_accounts) {
        accounts.push_back(r.read_bytes(32));
        i = i + 1;
    };

    let _recent_blockhash = r.read_bytes(32);

    let n_instructions = r.read_shortvec_len();
    assert!(n_instructions == 1, ENotSingleInstruction);

    let program_id_index = r.read_u8() as u64;
    assert!(program_id_index < n_accounts, EMalformed);
    // SystemProgram is the all-zero public key.
    let program = accounts.borrow(program_id_index);
    let mut z = 0;
    while (z < 32) {
        assert!(program[z] == 0, ENotSystemTransfer);
        z = z + 1;
    };

    let n_ix_accounts = r.read_shortvec_len();
    assert!(n_ix_accounts == 2, ENotSystemTransfer);
    let from_index = r.read_u8() as u64;
    let to_index = r.read_u8() as u64;
    assert!(from_index < n_accounts && to_index < n_accounts, EMalformed);

    let data_len = r.read_shortvec_len();
    assert!(data_len == 12, ENotSystemTransfer);
    let instruction = r.read_u32_le();
    // SystemInstruction::Transfer = 2
    assert!(instruction == 2, ENotSystemTransfer);
    let lamports = r.read_u64_le();

    // Whole message must be consumed.
    assert!(r.is_empty(), EMalformed);

    // The signer (account 0) must be the wallet, and the transfer source must
    // be the signer.
    assert!(accounts.borrow(0) == own_pubkey, ESourceNotSelf);
    assert!(from_index == 0, ESourceNotSelf);
    assert!(accounts.borrow(to_index) == destination, EDestinationMismatch);
    assert!((lamports as u128) == amount, EAmountMismatch);
}
