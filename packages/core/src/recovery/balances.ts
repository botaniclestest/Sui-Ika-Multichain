import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import type { MythosNetworkConfig } from '../config.js';
import { fetchBtcBalance } from '../chains/btc.js';
import { fetchErc20Balance, fetchEvmNativeBalance } from '../chains/evm.js';
import { fetchSolBalance, fetchSolTokenBalances } from '../chains/solana.js';
import { chainDescriptor } from '../chains/index.js';
import { getVaultBalances } from '../policy/state.js';
import { ChainKind, type ChainKindValue } from '../types.js';
import type { RecoveredWallet } from './discovery.js';

export interface ChainBalanceRow {
  chainKey: string;
  kind: ChainKindValue;
  assetKind: 'native' | 'token' | 'vault-coin';
  assetId: string;
  label: string;
  symbol: string;
  decimals: number;
  amount: bigint | null;
  confirmedAmount?: bigint;
  pendingAmount?: bigint;
  source: 'btc-esplora' | 'evm-rpc' | 'solana-rpc' | 'sui-vault';
  address?: string;
  tokenAccount?: string;
  mint?: string;
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
              assetKind: 'native',
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
          const [amount, tokenRows] = await Promise.all([
            fetchEvmNativeBalance(rpc, address),
            Promise.all(
              (config.evmTokens ?? [])
                .filter((token) => token.chainKey === chain.chainKey)
                .map(async (token): Promise<ChainBalanceRow | null> => {
                  let tokenAmount: bigint;
                  try {
                    tokenAmount = await fetchErc20Balance(rpc, token.address, address);
                  } catch {
                    return null;
                  }
                  if (tokenAmount === 0n) return null;
                  return {
                    chainKey: chain.chainKey,
                    kind: chain.kind,
                    assetKind: 'token',
                    assetId: token.address,
                    label: token.name ?? token.symbol,
                    symbol: token.symbol,
                    decimals: token.decimals,
                    amount: tokenAmount,
                    source: 'evm-rpc',
                    address,
                    status: 'ok',
                  };
                }),
            ),
          ]);
          return [
            {
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetKind: 'native',
              assetId: '',
              label: descriptor?.displayName ?? chain.chainKey,
              symbol: descriptor?.symbol ?? 'ETH',
              decimals: descriptor?.decimals ?? 18,
              amount,
              source: 'evm-rpc',
              address,
              status: 'ok',
            },
            ...tokenRows.filter((row): row is ChainBalanceRow => row !== null),
          ];
        }

        if (chain.kind === ChainKind.Solana) {
          if (!address) throw new Error('Solana address unknown');
          const amount = await fetchSolBalance(config.solanaRpcUrl, address);
          let tokens: Awaited<ReturnType<typeof fetchSolTokenBalances>> = [];
          try {
            tokens = await fetchSolTokenBalances(config.solanaRpcUrl, address);
          } catch {
            tokens = [];
          }
          return [
            {
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetKind: 'native',
              assetId: '',
              label: descriptor?.displayName ?? chain.chainKey,
              symbol: descriptor?.symbol ?? 'SOL',
              decimals: descriptor?.decimals ?? 9,
              amount,
              source: 'solana-rpc',
              address,
              status: 'ok',
            },
            ...tokens.map((token) => ({
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetKind: 'token' as const,
              assetId: token.mint,
              label: `SPL ${shortId(token.mint)}`,
              symbol: shortId(token.mint),
              decimals: token.decimals,
              amount: token.amount,
              source: 'solana-rpc' as const,
              address,
              tokenAccount: token.tokenAccount,
              mint: token.mint,
              status: 'ok' as const,
            })),
          ];
        }

        if (chain.kind === ChainKind.SuiVault) {
          const vaultBalances = await getVaultBalances(suiClient, recovered.state.walletId);
          const rows = await Promise.all(
            vaultBalances.map(async (balance) => {
              const metadata = await fetchSuiCoinMetadata(suiClient, balance.coinType);
              return {
                chainKey: chain.chainKey,
                kind: chain.kind,
                assetKind: 'vault-coin' as const,
                assetId: balance.coinType,
                label: metadata.name ?? balance.coinType,
                symbol: metadata.symbol ?? suiVaultSymbol(balance.coinType),
                decimals: metadata.decimals ?? suiVaultDecimals(balance.coinType),
                amount: balance.amount,
                source: 'sui-vault' as const,
                address: recovered.state.walletId,
                status: 'ok' as const,
              };
            }),
          );
          if (rows.length === 0) {
            rows.push({
              chainKey: chain.chainKey,
              kind: chain.kind,
              assetKind: 'vault-coin',
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
            assetKind: 'native',
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
            assetKind: 'native',
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

async function fetchSuiCoinMetadata(
  client: SuiClient,
  coinType: string,
): Promise<{ symbol?: string; decimals?: number; name?: string }> {
  try {
    const metadata = await client.getCoinMetadata({ coinType });
    return {
      symbol: metadata?.symbol || undefined,
      decimals: metadata?.decimals,
      name: metadata?.name || undefined,
    };
  } catch {
    return {};
  }
}

function shortId(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
