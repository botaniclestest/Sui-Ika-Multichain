/**
 * Solana nonce-rent payers, faucet-free and identical on devnet/mainnet.
 *
 * Preference order:
 *  1. A connected Solana browser wallet (Phantom/Solflare-compatible
 *     `window.solana` provider) pays the ~0.0015 SOL rent and signs.
 *  2. A local "gas tank": a dust-only keypair kept in localStorage. Fund it
 *     once with ~0.01 SOL from any wallet or faucet and it covers many
 *     requests. It is NOT custody-critical - it can only ever lose its own
 *     dust; nonce authority is always the policy wallet itself. If the
 *     browser profile is wiped, only unspent dust is lost.
 */

import { Keypair, PublicKey, Transaction as SolTransaction } from '@solana/web3.js';
import { payerFromKeypair, type SolPayer } from '@mythos/wallet-core';

const GAS_TANK_KEY = 'mythos-solana-gas-tank-v1';
const FAILED_NONCES_KEY = 'mythos-solana-failed-nonces-v1';

interface InjectedSolana {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array };
  connect(): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  signTransaction(tx: SolTransaction): Promise<SolTransaction>;
}

function injectedProvider(): InjectedSolana | null {
  const w = window as unknown as { solana?: InjectedSolana };
  return w.solana && typeof w.solana.signTransaction === 'function' ? w.solana : null;
}

export function loadGasTank(): Keypair {
  const stored = localStorage.getItem(GAS_TANK_KEY);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored) as number[]));
    } catch {
      /* regenerate below */
    }
  }
  const fresh = Keypair.generate();
  localStorage.setItem(GAS_TANK_KEY, JSON.stringify(Array.from(fresh.secretKey)));
  return fresh;
}

export function gasTankAddress(): string {
  return loadGasTank().publicKey.toBase58();
}

export interface ResolvedPayer {
  payer: SolPayer;
  source: 'browser-wallet' | 'gas-tank';
  address: string;
}

export interface FailedSolanaNonce {
  walletId: string;
  chainKey: string;
  noncePubkey: string;
  nonceValue: string;
  createdAtMs: number;
}

export function failedSolanaNonces(): FailedSolanaNonce[] {
  try {
    return JSON.parse(localStorage.getItem(FAILED_NONCES_KEY) ?? '[]') as FailedSolanaNonce[];
  } catch {
    return [];
  }
}

export function rememberFailedSolanaNonce(record: FailedSolanaNonce): void {
  const records = failedSolanaNonces().filter((n) => n.noncePubkey !== record.noncePubkey);
  records.unshift(record);
  localStorage.setItem(FAILED_NONCES_KEY, JSON.stringify(records.slice(0, 20)));
}

/**
 * Resolves the rent payer: connected Solana wallet first, gas tank second.
 * Throwing with a fundable address happens later, inside
 * `createDurableNonceAccount`, where the exact lamport need is known.
 */
export async function resolveSolanaPayer(): Promise<ResolvedPayer> {
  const provider = injectedProvider();
  if (provider) {
    try {
      const { publicKey } = await provider.connect();
      return {
        payer: {
          publicKey: new PublicKey(publicKey.toBytes()),
          signTransaction: (tx) => provider.signTransaction(tx),
        },
        source: 'browser-wallet',
        address: new PublicKey(publicKey.toBytes()).toBase58(),
      };
    } catch {
      // user rejected the connection - fall through to the gas tank
    }
  }
  const tank = loadGasTank();
  return {
    payer: payerFromKeypair(tank),
    source: 'gas-tank',
    address: tank.publicKey.toBase58(),
  };
}
