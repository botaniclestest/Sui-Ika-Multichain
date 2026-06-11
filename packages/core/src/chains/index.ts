/**
 * Chain adapter registry: one uniform surface over per-chain modules so new
 * chains plug in without touching wallet logic.
 */

import type { MythosNetworkConfig } from '../config.js';
import type { ChainKindValue } from '../types.js';
import { ChainKind } from '../types.js';

export interface ChainDescriptor {
  chainKey: string;
  kind: ChainKindValue;
  displayName: string;
  /** decimals of the native unit (sats=8 displayed as BTC, wei=18, etc.) */
  decimals: number;
  symbol: string;
  evmChainId?: bigint;
}

export const KNOWN_CHAINS: ChainDescriptor[] = [
  { chainKey: 'btc:mainnet', kind: ChainKind.Btc, displayName: 'Bitcoin', decimals: 8, symbol: 'BTC' },
  { chainKey: 'btc:testnet', kind: ChainKind.Btc, displayName: 'Bitcoin Testnet', decimals: 8, symbol: 'tBTC' },
  { chainKey: 'eip155:1', kind: ChainKind.Evm, displayName: 'Ethereum', decimals: 18, symbol: 'ETH', evmChainId: 1n },
  { chainKey: 'eip155:8453', kind: ChainKind.Evm, displayName: 'Base', decimals: 18, symbol: 'ETH', evmChainId: 8453n },
  { chainKey: 'eip155:42161', kind: ChainKind.Evm, displayName: 'Arbitrum One', decimals: 18, symbol: 'ETH', evmChainId: 42161n },
  { chainKey: 'eip155:10', kind: ChainKind.Evm, displayName: 'Optimism', decimals: 18, symbol: 'ETH', evmChainId: 10n },
  { chainKey: 'eip155:11155111', kind: ChainKind.Evm, displayName: 'Sepolia', decimals: 18, symbol: 'ETH', evmChainId: 11155111n },
  { chainKey: 'eip155:84532', kind: ChainKind.Evm, displayName: 'Base Sepolia', decimals: 18, symbol: 'ETH', evmChainId: 84532n },
  { chainKey: 'solana:mainnet', kind: ChainKind.Solana, displayName: 'Solana', decimals: 9, symbol: 'SOL' },
  { chainKey: 'solana:devnet', kind: ChainKind.Solana, displayName: 'Solana Devnet', decimals: 9, symbol: 'SOL' },
  { chainKey: 'sui:vault', kind: ChainKind.SuiVault, displayName: 'Sui Vault', decimals: 9, symbol: 'SUI' },
];

export function chainDescriptor(chainKey: string): ChainDescriptor | undefined {
  return KNOWN_CHAINS.find((c) => c.chainKey === chainKey);
}

export function evmRpcFor(config: MythosNetworkConfig, chainKey: string): string {
  const rpc = config.evmRpcUrls[chainKey];
  if (!rpc) throw new Error(`no RPC configured for ${chainKey}`);
  return rpc;
}

export * as btc from './btc.js';
export * as evm from './evm.js';
export * as solana from './solana.js';
// flat exports for ergonomic imports
export * from './btc.js';
export * from './evm.js';
export * from './solana.js';
