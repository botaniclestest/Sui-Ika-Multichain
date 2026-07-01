import { describe, expect, it } from 'vitest';
import {
  asBig,
  asBytes,
  bytesToUtf8,
  tableIdOf,
  unwrapFields,
  vecSetContents,
} from '../src/sui/rpc.js';

describe('transport-agnostic JSON shape helpers', () => {
  it('extracts table ids from gRPC/GraphQL handle shape', () => {
    expect(tableIdOf({ id: '0xabc', size: '2' })).toBe('0xabc');
  });

  it('extracts table ids from legacy JSON-RPC handle shape', () => {
    expect(tableIdOf({ fields: { id: { id: '0xdef' } } })).toBe('0xdef');
    expect(tableIdOf({ id: { id: '0x123' } })).toBe('0x123');
  });

  it('rejects unknown handle shapes', () => {
    expect(() => tableIdOf({})).toThrow();
    expect(() => tableIdOf(undefined)).toThrow();
  });

  it('reads VecSet contents in both shapes', () => {
    expect(vecSetContents({ contents: ['0xa', '0xb'] })).toEqual(['0xa', '0xb']);
    expect(vecSetContents({ fields: { contents: ['0xc'] } })).toEqual(['0xc']);
    expect(vecSetContents({ contents: [] })).toEqual([]);
  });

  it('unwraps legacy field wrappers and passes through flat JSON', () => {
    expect(unwrapFields({ type: 'x', fields: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapFields({ a: 1 })).toEqual({ a: 1 });
  });

  it('decodes vector<u8> as base64 (gRPC) and number arrays (legacy)', () => {
    // "solana:devnet" as emitted by gRPC JSON
    expect(bytesToUtf8('c29sYW5hOmRldm5ldA==')).toBe('solana:devnet');
    expect(bytesToUtf8([115, 117, 105])).toBe('sui');
    expect(asBytes('AAE=')).toEqual(Uint8Array.from([0, 1]));
  });

  it('parses u64/u128 renderings', () => {
    expect(asBig('18446744073709551615')).toBe(18446744073709551615n);
    expect(asBig(7)).toBe(7n);
  });
});
