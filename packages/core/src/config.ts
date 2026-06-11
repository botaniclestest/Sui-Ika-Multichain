/**
 * Network configuration.
 *
 * Everything needed to reconstruct the wallet from scratch is either here
 * (public, static identifiers) or on Sui chain state. None of it is secret:
 * a user who knows only their Sui key and the network name can rediscover
 * every wallet, address and pending request via `recovery/discovery.ts`.
 */

export type SuiNetwork = 'testnet' | 'mainnet';

export interface MythosNetworkConfig {
  network: SuiNetwork;
  suiRpcUrl: string;
  /** Published policy_wallet package id. */
  policyPackageId: string;
  /** Shared Registry object created on publish. */
  registryId: string;
  /** Target chain endpoints (public defaults; all replaceable). */
  btcEsploraUrl: string;
  evmRpcUrls: Record<string, string>; // chainKey -> rpc
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
    policyPackageId: '',
    registryId: '',
    btcEsploraUrl: 'https://blockstream.info/testnet/api',
    evmRpcUrls: {
      'eip155:11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
      'eip155:84532': 'https://sepolia.base.org',
    },
    solanaRpcUrl: 'https://api.devnet.solana.com',
  },
  mainnet: {
    network: 'mainnet',
    suiRpcUrl: 'https://fullnode.mainnet.sui.io:443',
    policyPackageId: '',
    registryId: '',
    btcEsploraUrl: 'https://blockstream.info/api',
    evmRpcUrls: {
      'eip155:1': 'https://ethereum-rpc.publicnode.com',
      'eip155:8453': 'https://mainnet.base.org',
      'eip155:42161': 'https://arb1.arbitrum.io/rpc',
      'eip155:10': 'https://mainnet.optimism.io',
    },
    solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
  },
};

export function resolveConfig(
  network: SuiNetwork,
  overrides?: Partial<MythosNetworkConfig>,
): MythosNetworkConfig {
  return { ...DEFAULT_CONFIGS[network], ...overrides };
}
