/** Byte/hex utilities shared across the core package. */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array, prefix = false): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `0x${hex}` : hex;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function u32le(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, true);
  return out;
}

export function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** Bitcoin CompactSize varint. */
export function btcVarint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const out = new Uint8Array(3);
    out[0] = 0xfd;
    new DataView(out.buffer).setUint16(1, n, true);
    return out;
  }
  const out = new Uint8Array(5);
  out[0] = 0xfe;
  new DataView(out.buffer).setUint32(1, n, true);
  return out;
}

/** Utf-8 string -> bytes (for Move vector<u8> chain keys). */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array | number[]): string {
  return new TextDecoder().decode(Uint8Array.from(b));
}

export function toBytes(input: Uint8Array | number[] | string): Uint8Array {
  if (typeof input === 'string') return hexToBytes(input);
  return Uint8Array.from(input);
}

/** Portable base64 decode (browser atob or Node Buffer, no bundler shims). */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as Record<string, any>)['Buffer'];
  return new Uint8Array(B.from(b64, 'base64'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  const B = (globalThis as Record<string, any>)['Buffer'];
  return B.from(bytes).toString('base64');
}
