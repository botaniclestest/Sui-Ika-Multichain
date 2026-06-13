import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import type { MythosNetworkConfig } from '../config.js';
import { fetchBtcBalance } from '../chains/btc.js';
import { fetchEvmNativeBalance } from '../chains/evm.js';
import { fetchSolBalance } from '../chains/solana.js';
import { chainDescriptor } from '../chains/index.js';
import { getVaultBalances } from '../policy/state.js';
import { ChainKind, type ChainKindValue } from '../types.js';
import type { RecoveredWallet } from './discovery.js';

export interface ChainBalanceRow {
  chainKey: string;
  kind: ChainKindValue;
  assetId: string;
  label: string;
  symbol: string;
  decimals: number;
  amount: bigint | null;
  confirmedAmount?: bigint;
  pendingAmount?: bigint;
  source: 'btc-esplora' | 'evm-rpc' | 'solana-rpc' | 'sui-vault';
  address?: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
}

export async function fetchRecoveredBalances(params: {
  suiClient: SuiClient;
  recovered: RecoveredWallet;
  config: MythosNetworkConfig;
}): Promise<ChainBalanceRow[]> {
  const { suiClient, recovered, config } = params;
  const tasks = [...recovered.state.chains.values()]
    .filter((chain) => chain.enabled)
    .map(async (chain): Promise<ChainBalanceRow[]> => {
      const descriptor = chainDescriptor(chain.chainKey);
      const address = recovered.addresses.find((a) => a.chainKey === chain.chainKey)?.address;
      try {
        if (chain.kind === ChainKind.Btc) {
          if (!address) throw new Error('BTC address unknown');
          const balance = await fetchBtcBalance(config.btcEsploraUrl, address);
          return [
            {
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetId: '',
              label: descriptor?.displayName ?? chain.chainKey,
              symbol: descriptor?.symbol ?? 'BTC',
              decimals: descriptor?.decimals ?? 8,
              amount: balance.total,
              confirmedAmount: balance.confirmed,
              pendingAmount: balance.unconfirmed,
              source: 'btc-esplora',
              address,
              status: 'ok',
            },
          ];
        }

        if (chain.kind === ChainKind.Evm) {
          if (!address) throw new Error('EVM address unknown');
          const rpc = config.evmRpcUrls[chain.chainKey];
          if (!rpc) throw new Error(`no RPC configured for ${chain.chainKey}`);
          const amount = await fetchEvmNativeBalance(rpc, address);
          return [
            {
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetId: '',
              label: descriptor?.displayName ?? chain.chainKey,
              symbol: descriptor?.symbol ?? 'ETH',
              decimals: descriptor?.decimals ?? 18,
              amount,
              source: 'evm-rpc',
              address,
              status: 'ok',
            },
          ];
        }

        if (chain.kind === ChainKind.Solana) {
          if (!address) throw new Error('Solana address unknown');
          const amount = await fetchSolBalance(config.solanaRpcUrl, address);
          return [
            {
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetId: '',
              label: descriptor?.displayName ?? chain.chainKey,
              symbol: descriptor?.symbol ?? 'SOL',
              decimals: descriptor?.decimals ?? 9,
              amount,
              source: 'solana-rpc',
              address,
              status: 'ok',
            },
          ];
        }

        if (chain.kind === ChainKind.SuiVault) {
          const vaultBalances = await getVaultBalances(suiClient, recovered.state.walletId);
          const rows = vaultBalances.map((balance) => ({
            chainKey: chain.chainKey,
            kind: chain.kind,
            assetId: balance.coinType,
            label: balance.coinType,
            symbol: suiVaultSymbol(balance.coinType),
            decimals: suiVaultDecimals(balance.coinType),
            amount: balance.amount,
            source: 'sui-vault' as const,
            address: recovered.state.walletId,
            status: 'ok' as const,
          }));
          if (rows.length === 0) {
            rows.push({
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetId: '0x2::sui::SUI',
              label: 'Sui Vault',
              symbol: 'SUI',
              decimals: 9,
              amount: 0n,
              source: 'sui-vault',
              address: recovered.state.walletId,
              status: 'ok',
            });
          }
          return rows;
        }

        return [
          {
            chainKey: chain.chainKey,
            kind: chain.kind,
            assetId: '',
            label: descriptor?.displayName ?? chain.chainKey,
            symbol: descriptor?.symbol ?? 'units',
            decimals: descriptor?.decimals ?? 0,
            amount: null,
            source: 'evm-rpc',
            address,
            status: 'skipped',
            error: 'balance reader not implemented for this chain kind',
          },
        ];
      } catch (e) {
        return [
          {
            chainKey: chain.chainKey,
            kind: chain.kind,
            assetId: '',
            label: descriptor?.displayName ?? chain.chainKey,
            symbol: descriptor?.symbol ?? 'units',
            decimals: descriptor?.decimals ?? 0,
            amount: null,
            source: balanceSourceFor(chain.kind),
            address,
            status: 'error',
            error: (e as Error).message,
          },
        ];
      }
    });
  return (await Promise.all(tasks)).flat();
}

function balanceSourceFor(kind: ChainKindValue): ChainBalanceRow['source'] {
  if (kind === ChainKind.Btc) return 'btc-esplora';
  if (kind === ChainKind.Solana) return 'solana-rpc';
  if (kind === ChainKind.SuiVault) return 'sui-vault';
  return 'evm-rpc';
}

function suiVaultSymbol(coinType: string): string {
  if (coinType === '0x2::sui::SUI') return 'SUI';
  return coinType.split('::').at(-1) ?? 'coin';
}

function suiVaultDecimals(coinType: string): number {
  return coinType === '0x2::sui::SUI' ? 9 : 0;
}
