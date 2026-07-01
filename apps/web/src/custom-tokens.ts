/**
 * User-tracked ERC-20 tokens (per browser, localStorage).
 *
 * Plain EVM RPC cannot DISCOVER unknown tokens for an address (there is no
 * "list all my token balances" call without an indexer), so the wallet
 * tracks exactly the contract addresses the user pastes in. This doubles
 * as spam filtering: airdropped junk never shows up unless added here.
 */

import type { KnownEvmToken } from '@mythos/wallet-core';

const CUSTOM_TOKENS_KEY = 'mythos-custom-evm-tokens-v1';

export function loadCustomEvmTokens(): KnownEvmToken[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY) ?? '[]') as KnownEvmToken[];
    return Array.isArray(parsed) ? parsed.filter((t) => t?.chainKey && t?.address) : [];
  } catch {
    return [];
  }
}

export function saveCustomEvmTokens(tokens: KnownEvmToken[]): void {
  localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(tokens));
}

export function addCustomEvmToken(token: KnownEvmToken): KnownEvmToken[] {
  const rest = loadCustomEvmTokens().filter(
    (t) => !(t.chainKey === token.chainKey && t.address.toLowerCase() === token.address.toLowerCase()),
  );
  const next = [...rest, token];
  saveCustomEvmTokens(next);
  return next;
}

export function removeCustomEvmToken(chainKey: string, address: string): KnownEvmToken[] {
  const next = loadCustomEvmTokens().filter(
    (t) => !(t.chainKey === chainKey && t.address.toLowerCase() === address.toLowerCase()),
  );
  saveCustomEvmTokens(next);
  return next;
}
