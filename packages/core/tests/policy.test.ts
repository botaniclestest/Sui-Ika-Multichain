import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/codec.js';
import { assertDestinationPolicy, checkDestinationPolicy } from '../src/policy/destination.js';

const DESTINATION = hexToBytes('11'.repeat(32));
const OTHER_DESTINATION = hexToBytes('22'.repeat(32));

describe('destination policy checks', () => {
  it('rejects blocklisted destinations before allowlist checks', () => {
    const check = checkDestinationPolicy(
      {
        allowlistEnabled: true,
        allowlist: [bytesToHex(DESTINATION)],
        blocklist: [bytesToHex(DESTINATION).toUpperCase()],
      },
      DESTINATION,
    );

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe('blocklist');
      expect(check.message).toContain('blocklist');
    }
  });

  it('requires allowlist membership only when enforcement is on', () => {
    expect(
      checkDestinationPolicy(
        { allowlistEnabled: false, allowlist: [], blocklist: [] },
        DESTINATION,
      ).ok,
    ).toBe(true);

    const denied = checkDestinationPolicy(
      { allowlistEnabled: true, allowlist: [bytesToHex(OTHER_DESTINATION)], blocklist: [] },
      DESTINATION,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('allowlist');

    expect(() =>
      assertDestinationPolicy(
        { allowlistEnabled: true, allowlist: [bytesToHex(OTHER_DESTINATION)], blocklist: [] },
        DESTINATION,
      ),
    ).toThrow(/not on the allowlist/);
  });
});
