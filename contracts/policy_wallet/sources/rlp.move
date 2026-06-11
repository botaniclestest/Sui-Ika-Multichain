// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// Minimal RLP decoder used to verify EVM transaction intents on-chain.
///
/// Only the subset of RLP needed for EIP-1559 transaction payloads is
/// implemented: strings (byte arrays) and list headers. Every read is
/// bounds-checked; canonical encoding is enforced (no leading zeros in
/// scalars, minimal length prefixes), so two different encodings of the
/// same logical transaction cannot both pass verification.
module policy_wallet::rlp;

use policy_wallet::reader::{Self, Reader};

const ENotAString: u64 = 0;
const ENotAList: u64 = 1;
const ENonCanonical: u64 = 2;
const EScalarTooLong: u64 = 3;

/// Reads an RLP string item (byte array) from the reader.
public fun read_string(r: &mut reader::Reader): vector<u8> {
    let prefix = r.read_u8();
    if (prefix < 0x80) {
        // Single byte, value is the byte itself.
        vector[prefix]
    } else if (prefix <= 0xb7) {
        let len = (prefix - 0x80) as u64;
        let out = r.read_bytes(len);
        // Canonical: single bytes < 0x80 must be encoded as themselves.
        assert!(!(len == 1 && out[0] < 0x80), ENonCanonical);
        out
    } else if (prefix <= 0xbf) {
        let len_of_len = (prefix - 0xb7) as u64;
        let len = read_be_len(r, len_of_len);
        // Canonical: long form only for len > 55.
        assert!(len > 55, ENonCanonical);
        r.read_bytes(len)
    } else {
        abort ENotAString
    }
}

/// Reads an RLP list header and returns the byte length of the list payload.
public fun read_list_header(r: &mut reader::Reader): u64 {
    let prefix = r.read_u8();
    if (prefix >= 0xc0 && prefix <= 0xf7) {
        (prefix - 0xc0) as u64
    } else if (prefix >= 0xf8) {
        let len_of_len = (prefix - 0xf7) as u64;
        let len = read_be_len(r, len_of_len);
        assert!(len > 55, ENonCanonical);
        len
    } else {
        abort ENotAList
    }
}

/// Reads an RLP scalar (canonical big-endian integer, no leading zeros)
/// as u128.
public fun read_scalar_u128(r: &mut reader::Reader): u128 {
    let bytes = read_string(r);
    if (bytes.length() == 1 && bytes[0] == 0) {
        // RLP canonical zero is the empty string (0x80); a 0x00 byte string
        // is non-canonical for scalars.
        abort ENonCanonical
    };
    assert!(bytes.length() <= 16, EScalarTooLong);
    if (bytes.length() > 0) {
        assert!(bytes[0] != 0, ENonCanonical);
    };
    reader::be_bytes_to_u128(&bytes)
}

/// Reads an RLP scalar allowing values up to 32 bytes, returned raw
/// (big-endian, no leading zeros). Used for u256-sized fields where we only
/// need comparisons.
public fun read_scalar_bytes(r: &mut reader::Reader): vector<u8> {
    let bytes = read_string(r);
    if (bytes.length() > 0) {
        assert!(bytes[0] != 0, ENonCanonical);
    };
    assert!(bytes.length() <= 32, EScalarTooLong);
    bytes
}

fun read_be_len(r: &mut Reader, len_of_len: u64): u64 {
    assert!(len_of_len >= 1 && len_of_len <= 8, ENonCanonical);
    let bytes = r.read_bytes(len_of_len);
    // Canonical: no leading zeros in the length encoding.
    assert!(bytes[0] != 0, ENonCanonical);
    let mut v: u64 = 0;
    let mut i = 0;
    while (i < bytes.length()) {
        v = (v << 8) | (bytes[i] as u64);
        i = i + 1;
    };
    v
}
