import { bytesToHex } from '../codec.js';
import type { ChainPolicyState } from '../types.js';

export type DestinationPolicyFailureReason = 'blocklist' | 'allowlist';

export type DestinationPolicyCheck =
  | { ok: true; destinationHex: string }
  | {
      ok: false;
      destinationHex: string;
      reason: DestinationPolicyFailureReason;
      message: string;
    };

function hasHexEntry(entries: string[], destinationHex: string): boolean {
  const needle = destinationHex.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === needle);
}

export function checkDestinationPolicy(
  chain: Pick<ChainPolicyState, 'allowlistEnabled' | 'allowlist' | 'blocklist'>,
  destination: Uint8Array,
): DestinationPolicyCheck {
  const destinationHex = bytesToHex(destination);

  if (hasHexEntry(chain.blocklist, destinationHex)) {
    return {
      ok: false,
      destinationHex,
      reason: 'blocklist',
      message: "Destination is on this wallet's blocklist. No spend request was created.",
    };
  }

  if (chain.allowlistEnabled && !hasHexEntry(chain.allowlist, destinationHex)) {
    return {
      ok: false,
      destinationHex,
      reason: 'allowlist',
      message: 'Allowlist enforcement is on and this destination is not on the allowlist. No spend request was created.',
    };
  }

  return { ok: true, destinationHex };
}

export function assertDestinationPolicy(
  chain: Pick<ChainPolicyState, 'allowlistEnabled' | 'allowlist' | 'blocklist'>,
  destination: Uint8Array,
): void {
  const check = checkDestinationPolicy(chain, destination);
  if (!check.ok) throw new Error(check.message);
}
