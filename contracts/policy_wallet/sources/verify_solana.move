// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// On-chain verification of Solana spend intents.
///
/// The message Ika signs for Solana is the exact serialized legacy message
/// (EdDSA over the message bytes). This module parses that message and proves
/// it is a SystemProgram transfer that:
///   * is fee-paid and signed by this wallet's Solana account only,
///   * moves exactly `amount` lamports to `destination`,
///   * contains no other instructions (except an optional leading
///     durable-nonce advance, see below).
///
/// ## Durable nonces
/// A recent-blockhash transaction expires ~60-90s after creation - far less
/// than any realistic multisig voting window - so policy-gated Solana
/// transfers MUST use durable nonces. The verifier therefore also accepts
/// the two-instruction form:
///   1. SystemProgram::AdvanceNonceAccount(nonce_account, recent_blockhashes
///      sysvar, authority == the wallet)
///   2. SystemProgram::Transfer(wallet -> destination, amount)
/// The nonce authority must be the wallet itself, so only the policy-gated
/// signature can consume the nonce.
///
/// SPL token transfers use the durable-nonce form plus an idempotent associated
/// token account create instruction and an SPL Token `TransferChecked`.
module policy_wallet::verify_solana;

use policy_wallet::reader::{Self, Reader};

const EVersionedMessage: u64 = 0;
const EMalformed: u64 = 1;
const ENotSingleInstruction: u64 = 2;
const ENotSystemTransfer: u64 = 3;
const ESourceNotSelf: u64 = 4;
const EDestinationMismatch: u64 = 5;
const EAmountMismatch: u64 = 6;
const EBadHeader: u64 = 7;
const EBadNonceAdvance: u64 = 8;
const EBadSplTransfer: u64 = 9;
const EBadTokenProgram: u64 = 10;
const EBadAssociatedTokenProgram: u64 = 11;

/// SysvarRecentB1ockHashes11111111111111111111
const SYSVAR_RECENT_BLOCKHASHES: vector<u8> =
    x"06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000";

/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const SPL_TOKEN_PROGRAM: vector<u8> =
    x"06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9";

/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
const ASSOCIATED_TOKEN_PROGRAM: vector<u8> =
    x"8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859";

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
    let native_asset = vector[];
    verify_with_asset(message, own_pubkey, &native_asset, destination, amount)
}

/// Verifies native SOL when `asset` is empty, or an SPL token transfer when
/// `asset` is a 32-byte mint. For SPL, `destination` is the recipient owner
/// address; the message must create that owner's associated token account
/// idempotently and transfer to it with Token Program `TransferChecked`.
public(package) fun verify_with_asset(
    message: &vector<u8>,
    own_pubkey: &vector<u8>,
    asset: &vector<u8>,
    destination: &vector<u8>,
    amount: u128,
) {
    assert!(own_pubkey.length() == 32, EMalformed);
    assert!(destination.length() == 32, EDestinationMismatch);
    let is_spl = !asset.is_empty();
    if (is_spl) {
        assert!(asset.length() == 32, EBadSplTransfer);
    };

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

    let _recent_blockhash_or_nonce = r.read_bytes(32);

    let n_instructions = r.read_shortvec_len();
    if (is_spl) {
        assert!(n_instructions == 3, EBadSplTransfer);
    } else {
        // 1 instruction  = plain transfer (recent blockhash; expires fast)
        // 2 instructions = durable nonce advance + transfer (recommended)
        assert!(n_instructions == 1 || n_instructions == 2, ENotSingleInstruction);
    };

    if (n_instructions == 2 || is_spl) {
        verify_nonce_advance(&mut r, &accounts, own_pubkey);
    };

    if (is_spl) {
        let ata = verify_ata_create_idempotent(&mut r, &accounts, asset, destination);
        verify_spl_transfer_checked(&mut r, &accounts, own_pubkey, asset, &ata, amount);
    } else {
        verify_transfer(&mut r, &accounts, own_pubkey, destination, amount);
    };

    // Whole message must be consumed.
    assert!(r.is_empty(), EMalformed);

    // The signer (account 0) must be the wallet.
    assert!(accounts.borrow(0) == own_pubkey, ESourceNotSelf);
}

/// AssociatedTokenAccountInstruction::CreateIdempotent for the declared owner
/// and mint. The ATA program enforces the PDA derivation at execution time;
/// this verifier binds the owner/mint and requires the transfer to use the
/// same account created here.
fun verify_ata_create_idempotent(
    r: &mut Reader,
    accounts: &vector<vector<u8>>,
    mint: &vector<u8>,
    destination_owner: &vector<u8>,
): vector<u8> {
    let n_accounts = accounts.length();
    let program_id_index = r.read_u8() as u64;
    assert!(program_id_index < n_accounts, EMalformed);
    assert_associated_token_program(accounts.borrow(program_id_index));

    let n_ix_accounts = r.read_shortvec_len();
    assert!(n_ix_accounts == 6, EBadSplTransfer);
    let payer_index = r.read_u8() as u64;
    let ata_index = r.read_u8() as u64;
    let owner_index = r.read_u8() as u64;
    let mint_index = r.read_u8() as u64;
    let system_index = r.read_u8() as u64;
    let token_program_index = r.read_u8() as u64;
    assert!(
        payer_index < n_accounts && ata_index < n_accounts && owner_index < n_accounts &&
            mint_index < n_accounts && system_index < n_accounts && token_program_index < n_accounts,
        EMalformed,
    );
    assert!(payer_index == 0, EBadSplTransfer);
    assert!(accounts.borrow(owner_index) == destination_owner, EDestinationMismatch);
    assert!(accounts.borrow(mint_index) == mint, EBadSplTransfer);
    assert_system_program(accounts.borrow(system_index));
    assert_spl_token_program(accounts.borrow(token_program_index));

    let data_len = r.read_shortvec_len();
    assert!(data_len == 1, EBadSplTransfer);
    let instruction = r.read_u8();
    // AssociatedTokenAccountInstruction::CreateIdempotent = 1
    assert!(instruction == 1, EBadSplTransfer);

    *accounts.borrow(ata_index)
}

/// SPL Token `TransferChecked { amount, decimals }` from a wallet-owned token
/// account to the ATA created above. Token Program validates source ownership,
/// destination mint, and decimals against the mint at execution time.
fun verify_spl_transfer_checked(
    r: &mut Reader,
    accounts: &vector<vector<u8>>,
    own_pubkey: &vector<u8>,
    mint: &vector<u8>,
    destination_ata: &vector<u8>,
    amount: u128,
) {
    let n_accounts = accounts.length();
    let program_id_index = r.read_u8() as u64;
    assert!(program_id_index < n_accounts, EMalformed);
    assert_spl_token_program(accounts.borrow(program_id_index));

    let n_ix_accounts = r.read_shortvec_len();
    assert!(n_ix_accounts == 4, EBadSplTransfer);
    let _source_index = r.read_u8() as u64;
    let mint_index = r.read_u8() as u64;
    let destination_index = r.read_u8() as u64;
    let owner_index = r.read_u8() as u64;
    assert!(
        _source_index < n_accounts && mint_index < n_accounts &&
            destination_index < n_accounts && owner_index < n_accounts,
        EMalformed,
    );
    assert!(owner_index == 0, ESourceNotSelf);
    assert!(accounts.borrow(owner_index) == own_pubkey, ESourceNotSelf);
    assert!(accounts.borrow(mint_index) == mint, EBadSplTransfer);
    assert!(accounts.borrow(destination_index) == destination_ata, EDestinationMismatch);

    let data_len = r.read_shortvec_len();
    assert!(data_len == 10, EBadSplTransfer);
    let instruction = r.read_u8();
    // TokenInstruction::TransferChecked = 12
    assert!(instruction == 12, EBadSplTransfer);
    let token_amount = r.read_u64_le();
    let _decimals = r.read_u8();
    assert!((token_amount as u128) == amount, EAmountMismatch);
}

/// SystemProgram::AdvanceNonceAccount with the wallet as nonce authority.
fun verify_nonce_advance(
    r: &mut Reader,
    accounts: &vector<vector<u8>>,
    own_pubkey: &vector<u8>,
) {
    let n_accounts = accounts.length();
    let program_id_index = r.read_u8() as u64;
    assert!(program_id_index < n_accounts, EMalformed);
    assert_system_program(accounts.borrow(program_id_index));

    let n_ix_accounts = r.read_shortvec_len();
    assert!(n_ix_accounts == 3, EBadNonceAdvance);
    let _nonce_index = r.read_u8() as u64;
    let sysvar_index = r.read_u8() as u64;
    let authority_index = r.read_u8() as u64;
    assert!(
        _nonce_index < n_accounts && sysvar_index < n_accounts && authority_index < n_accounts,
        EMalformed,
    );
    assert!(authority_index == 0, EBadNonceAdvance);
    let sysvar_recent_blockhashes = SYSVAR_RECENT_BLOCKHASHES;
    assert!(accounts.borrow(sysvar_index) == &sysvar_recent_blockhashes, EBadNonceAdvance);
    // Only the policy-gated wallet signature may consume the nonce.
    assert!(accounts.borrow(authority_index) == own_pubkey, EBadNonceAdvance);

    let data_len = r.read_shortvec_len();
    assert!(data_len == 4, EBadNonceAdvance);
    let instruction = r.read_u32_le();
    // SystemInstruction::AdvanceNonceAccount = 4
    assert!(instruction == 4, EBadNonceAdvance);
}

/// SystemProgram::Transfer from the wallet to the declared destination.
fun verify_transfer(
    r: &mut Reader,
    accounts: &vector<vector<u8>>,
    own_pubkey: &vector<u8>,
    destination: &vector<u8>,
    amount: u128,
) {
    let n_accounts = accounts.length();
    let program_id_index = r.read_u8() as u64;
    assert!(program_id_index < n_accounts, EMalformed);
    assert_system_program(accounts.borrow(program_id_index));

    let n_ix_accounts = r.read_shortvec_len();
    assert!(n_ix_accounts == 2, ENotSystemTransfer);
    let from_index = r.read_u8() as u64;
    let to_index = r.read_u8() as u64;
    assert!(from_index < n_accounts && to_index < n_accounts, EMalformed);
    assert!(from_index == 0, ESourceNotSelf);

    let data_len = r.read_shortvec_len();
    assert!(data_len == 12, ENotSystemTransfer);
    let instruction = r.read_u32_le();
    // SystemInstruction::Transfer = 2
    assert!(instruction == 2, ENotSystemTransfer);
    let lamports = r.read_u64_le();

    // The transfer source must be the wallet signer.
    assert!(accounts.borrow(from_index) == own_pubkey, ESourceNotSelf);
    assert!(accounts.borrow(to_index) == destination, EDestinationMismatch);
    assert!((lamports as u128) == amount, EAmountMismatch);
}

fun assert_system_program(key: &vector<u8>) {
    let mut z = 0;
    while (z < 32) {
        assert!(key[z] == 0, ENotSystemTransfer);
        z = z + 1;
    };
}

fun assert_spl_token_program(key: &vector<u8>) {
    let token_program = SPL_TOKEN_PROGRAM;
    assert!(key == &token_program, EBadTokenProgram);
}

fun assert_associated_token_program(key: &vector<u8>) {
    let associated_token_program = ASSOCIATED_TOKEN_PROGRAM;
    assert!(key == &associated_token_program, EBadAssociatedTokenProgram);
}
