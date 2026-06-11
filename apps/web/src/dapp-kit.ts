import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

const rpcUrls = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
} as const;

export const dAppKit = createDAppKit({
  networks: ['testnet', 'mainnet'] as const,
  defaultNetwork: 'testnet' as const,
  createClient(network) {
    return new SuiJsonRpcClient({ network, url: rpcUrls[network] });
  },
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
