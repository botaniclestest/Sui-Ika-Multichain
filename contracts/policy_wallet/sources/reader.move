// Mythos Policy Wallet
// SPDX-License-Identifier: BSD-3-Clause-Clear

/// Minimal byte-cursor utilities used by the on-chain transaction-intent
/// verifiers (BTC BIP-143 preimages, EVM RLP payloads, Solana messages).
///
/// All read functions abort on out-of-bounds access, so a malformed payload
/// can never be silently accepted.
module policy_wallet::reader;

const EOutOfBounds: u64 = 0;
const EVarIntTooLarge: u64 = 1;

public struct Reader has copy, drop {
    bytes: vector<u8>,
    cursor: u64,
}

public fun new(bytes: vector<u8>): Reader {
    Reader { bytes, cursor: 0 }
}

public fun remaining(self: &Reader): u64 {
    self.bytes.length() - self.cursor
}

public fun is_empty(self: &Reader): bool {
    self.cursor == self.bytes.length()
}

public fun cursor(self: &Reader): u64 {
    self.cursor
}

public fun read_u8(self: &mut Reader): u8 {
    assert!(self.cursor < self.bytes.length(), EOutOfBounds);
    let b = self.bytes[self.cursor];
    self.cursor = self.cursor + 1;
    b
}

public fun read_bytes(self: &mut Reader, len: u64): vector<u8> {
    assert!(self.cursor + len <= self.bytes.length(), EOutOfBounds);
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        out.push_back(self.bytes[self.cursor + i]);
        i = i + 1;
    };
    self.cursor = self.cursor + len;
    out
}

public fun skip(self: &mut Reader, len: u64) {
    assert!(self.cursor + len <= self.bytes.length(), EOutOfBounds);
    self.cursor = self.cursor + len;
}

/// Little-endian u16.
public fun read_u16_le(self: &mut Reader): u16 {
    let b0 = self.read_u8() as u16;
    let b1 = self.read_u8() as u16;
    b0 | (b1 << 8)
}

/// Little-endian u32.
public fun read_u32_le(self: &mut Reader): u32 {
    let mut v: u32 = 0;
    let mut i: u8 = 0;
    while (i < 4) {
        v = v | ((self.read_u8() as u32) << (i * 8));
        i = i + 1;
    };
    v
}

/// Little-endian u64.
public fun read_u64_le(self: &mut Reader): u64 {
    let mut v: u64 = 0;
    let mut i: u8 = 0;
    while (i < 8) {
        v = v | ((self.read_u8() as u64) << (i * 8));
        i = i + 1;
    };
    v
}

/// Bitcoin CompactSize varint.
public fun read_btc_varint(self: &mut Reader): u64 {
    let first = self.read_u8();
    if (first < 0xfd) {
        first as u64
    } else if (first == 0xfd) {
        self.read_u16_le() as u64
    } else if (first == 0xfe) {
        self.read_u32_le() as u64
    } else {
        abort EVarIntTooLarge
    }
}

/// Solana shortvec (compact-u16) length encoding.
public fun read_shortvec_len(self: &mut Reader): u64 {
    let mut len: u64 = 0;
    let mut shift: u8 = 0;
    loop {
        let byte = self.read_u8();
        len = len | (((byte & 0x7f) as u64) << shift);
        if (byte & 0x80 == 0) break;
        shift = shift + 7;
        assert!(shift <= 14, EVarIntTooLarge);
    };
    len
}

/// Interpret big-endian bytes as u128. Aborts if longer than 16 bytes.
public fun be_bytes_to_u128(bytes: &vector<u8>): u128 {
    assert!(bytes.length() <= 16, EVarIntTooLarge);
    let mut v: u128 = 0;
    let mut i = 0;
    while (i < bytes.length()) {
        v = (v << 8) | (bytes[i] as u128);
        i = i + 1;
    };
    v
}

/// Slice helper: bytes[start..start+len].
public fun slice(bytes: &vector<u8>, start: u64, len: u64): vector<u8> {
    assert!(start + len <= bytes.length(), EOutOfBounds);
    let mut out = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        out.push_back(bytes[start + i]);
        i = i + 1;
    };
    out
}
