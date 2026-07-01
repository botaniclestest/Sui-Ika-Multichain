/**
 * Network configuration.
 *
 * Everything needed to reconstruct the wallet from scratch is either here
 * (public, static identifiers) or on Sui chain state. None of it is secret:
 * a user who knows only their Sui key and the network name can rediscover
 * every wallet, address and pending request via `recovery/discovery.ts`.
 */

export type SuiNetwork = 'testnet' | 'mainnet';

export interface KnownEvmToken {
  chainKey: string;
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
}

export interface MythosNetworkConfig {
  network: SuiNetwork;
  /**
   * Sui fullnode endpoint. Served over gRPC(-Web) by the SDK's
   * `SuiGrpcClient` (Sui is deprecating JSON-RPC; the same host serves
   * both, so older JSON-RPC clients keep working during migration).
   */
  suiRpcUrl: string;
  /** Sui GraphQL (indexer) endpoint - used for event-history queries. */
  suiGraphqlUrl: string;
  /** Published policy_wallet package id. */
  policyPackageId: string;
  /** Shared Registry object created on publish. */
  registryId: string;
  /** Target chain endpoints (public defaults; all replaceable). */
  btcEsploraUrl: string;
  evmRpcUrls: Record<string, string>; // chainKey -> rpc
  evmTokens?: KnownEvmToken[];
  solanaRpcUrl: string;
}

/**
 * Deployment values. `policyPackageId` / `registryId` are filled in by
 * `scripts/publish.ts` (which writes deployments.json); they can also be
 * supplied at runtime so a rebuilt frontend can point at the same wallet.
 */
export const DEFAULT_CONFIGS: Record<SuiNetwork, MythosNetworkConfig> = {
  testnet: {
    network: 'testnet',
    suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
    suiGraphqlUrl: 'https://graphql.testnet.sui.io/graphql',
    policyPackageId: '',
    registryId: '',
    btcEsploraUrl: 'https://blockstream.info/testnet/api',
    evmRpcUrls: {
      'eip155:11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
      'eip155:84532': 'https://sepolia.base.org',
    },
    evmTokens: [],
    solanaRpcUrl: 'https://api.devnet.solana.com',
  },
  mainnet: {
    network: 'mainnet',
    suiRpcUrl: 'https://fullnode.mainnet.sui.io:443',
    suiGraphqlUrl: 'https://graphql.mainnet.sui.io/graphql',
    policyPackageId: '',
    registryId: '',
    btcEsploraUrl: 'https://blockstream.info/api',
    evmRpcUrls: {
      'eip155:1': 'https://ethereum-rpc.publicnode.com',
      'eip155:8453': 'https://mainnet.base.org',
      'eip155:42161': 'https://arb1.arbitrum.io/rpc',
      'eip155:10': 'https://mainnet.optimism.io',
    },
    evmTokens: [
      { chainKey: 'eip155:1', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
      { chainKey: 'eip155:8453', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
      { chainKey: 'eip155:42161', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
      { chainKey: 'eip155:10', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    ],
    solanaRpcUrl: 'https://solana-rpc.publicnode.com',
  },
};

export function resolveConfig(
  network: SuiNetwork,
  overrides?: Partial<MythosNetworkConfig>,
): MythosNetworkConfig {
  return { ...DEFAULT_CONFIGS[network], ...overrides };
}
