import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';

// Sui is deprecating JSON-RPC: the app talks to fullnodes over gRPC-Web
// (same public hosts serve both protocols during the migration window).
const rpcUrls = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
} as const;

export function createSuiClient(network: 'testnet' | 'mainnet'): SuiGrpcClient {
  return new SuiGrpcClient({ network, baseUrl: rpcUrls[network] });
}

export const dAppKit = createDAppKit({
  networks: ['testnet', 'mainnet'] as const,
  defaultNetwork: 'testnet' as const,
  createClient(network) {
    return createSuiClient(network);
  },
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
