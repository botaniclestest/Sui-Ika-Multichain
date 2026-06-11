// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// On-chain verification of EVM spend intents.
///
/// The message Ika signs for an EVM transaction is the raw serialized
/// unsigned EIP-1559 transaction (`0x02 || rlp([...])`); the Ika network
/// applies KECCAK256 itself. Because the full unsigned transaction is on
/// chain, this module parses it and proves that:
///   * the transaction targets the configured chain id (no cross-chain
///     replay between EVM networks),
///   * a native transfer pays exactly `amount` wei to `destination` with no
///     calldata, or
///   * an ERC-20 `transfer(address,uint256)` call on the declared token
///     contract pays exactly `amount` tokens to `destination` with zero ETH
///     value,
///   * the maximum gas spend (maxFeePerGas * gasLimit) is within the
///     configured fee limit.
module policy_wallet::verify_evm;

use policy_wallet::reader;
use policy_wallet::rlp;

const ENotEip1559: u64 = 0;
const ETrailingBytes: u64 = 1;
const EChainIdMismatch: u64 = 2;
const EBadToAddress: u64 = 3;
const EDestinationMismatch: u64 = 4;
const EAmountMismatch: u64 = 5;
const EValueNotZero: u64 = 6;
const ECalldataNotTransfer: u64 = 7;
const EAccessListNotEmpty: u64 = 8;
const EFeeTooHigh: u64 = 9;
const EAmountOverflow: u64 = 10;
const EBadAssetAddress: u64 = 11;

/// Verifies an EVM spend intent. Aborts unless every check passes.
///
/// * `message`     - raw unsigned EIP-1559 tx bytes (0x02 || rlp list).
/// * `chain_id`    - the EVM chain id configured for this chain policy.
/// * `asset`       - empty for native ETH; 20-byte token address for ERC-20.
/// * `destination` - declared 20-byte recipient.
/// * `amount`      - declared amount (wei or token base units).
/// * `fee_limit`   - max allowed wei of gas spend (maxFeePerGas * gasLimit).
public(package) fun verify(
    message: &vector<u8>,
    chain_id: u128,
    asset: &vector<u8>,
    destination: &vector<u8>,
    amount: u128,
    fee_limit: u128,
) {
    assert!(destination.length() == 20, EDestinationMismatch);
    let mut r = reader::new(*message);
    assert!(r.read_u8() == 0x02, ENotEip1559);

    let list_len = rlp::read_list_header(&mut r);
    let list_start = r.cursor();

    let tx_chain_id = rlp::read_scalar_u128(&mut r);
    assert!(tx_chain_id == chain_id, EChainIdMismatch);

    let _nonce = rlp::read_scalar_u128(&mut r);
    let _max_priority_fee = rlp::read_scalar_u128(&mut r);
    let max_fee_per_gas = rlp::read_scalar_u128(&mut r);
    let gas_limit = rlp::read_scalar_u128(&mut r);

    let to = rlp::read_string(&mut r);
    assert!(to.length() == 20, EBadToAddress);

    let value_bytes = rlp::read_scalar_bytes(&mut r);
    let data = rlp::read_string(&mut r);

    // Access list must be the empty list (0xc0).
    let access_list_len = rlp::read_list_header(&mut r);
    assert!(access_list_len == 0, EAccessListNotEmpty);

    // The RLP list payload and the whole message must be fully consumed.
    assert!(r.cursor() == list_start + list_len, ETrailingBytes);
    assert!(r.is_empty(), ETrailingBytes);

    // Gas spend bound.
    let max_gas_cost = max_fee_per_gas * gas_limit;
    assert!(max_gas_cost <= fee_limit, EFeeTooHigh);

    if (asset.length() == 0) {
        // Native transfer: no calldata, exact value, exact destination.
        assert!(data.length() == 0, ECalldataNotTransfer);
        assert!(&to == destination, EDestinationMismatch);
        let value = value_to_u128(&value_bytes);
        assert!(value == amount, EAmountMismatch);
    } else {
        // ERC-20 transfer: to == token contract, value == 0,
        // data == transfer(destination, amount).
        assert!(asset.length() == 20, EBadAssetAddress);
        assert!(&to == asset, EDestinationMismatch);
        assert!(value_bytes.length() == 0, EValueNotZero);
        assert!(data.length() == 68, ECalldataNotTransfer);
        // selector a9059cbb
        assert!(
            data[0] == 0xa9 && data[1] == 0x05 && data[2] == 0x9c && data[3] == 0xbb,
            ECalldataNotTransfer,
        );
        // param 1: 32-byte left-padded recipient address.
        let mut i = 0;
        while (i < 12) {
            assert!(data[4 + i] == 0, ECalldataNotTransfer);
            i = i + 1;
        };
        let recipient = reader::slice(&data, 16, 20);
        assert!(&recipient == destination, EDestinationMismatch);
        // param 2: 32-byte big-endian amount; top 16 bytes must be zero so it
        // fits in u128 (we never approve amounts above 2^128-1).
        let mut j = 0;
        while (j < 16) {
            assert!(data[36 + j] == 0, EAmountOverflow);
            j = j + 1;
        };
        let amount_bytes = reader::slice(&data, 52, 16);
        let token_amount = reader::be_bytes_to_u128(&amount_bytes);
        assert!(token_amount == amount, EAmountMismatch);
    }
}

fun value_to_u128(value_bytes: &vector<u8>): u128 {
    assert!(value_bytes.length() <= 16, EAmountOverflow);
    reader::be_bytes_to_u128(value_bytes)
}
