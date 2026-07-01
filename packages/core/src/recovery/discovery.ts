/**
 * Recovery & discovery.
 *
 * The "frontend can disappear" guarantee, implemented. Starting from ONLY:
 *   1. a Sui keypair (any signer of the wallet), and
 *   2. the published package id + registry id (public constants),
 * any signer can rediscover every wallet they belong to, every derived
 * address on every chain, the full policy configuration and all pending
 * requests - then keep approving and spending from a brand new client.
 *
 * Discovery sources (all on-chain, all redundant):
 *   a. owned SignerCap objects        (listOwnedObjects by struct type)
 *   b. the shared Registry table      (signer address -> wallet ids)
 *   c. WalletCreated events           (GraphQL fallback scan)
 */

import { bytesEqual, bytesToHex } from '../codec.js';
import type { SuiClientTypes } from '@mysten/sui/client';
import { deriveBtcAddress, p2wpkhScript, type BtcNetwork } from '../chains/btc.js';
import { deriveEvmAddress, evmAddressBytes } from '../chains/evm.js';
import { deriveSolanaAddress } from '../chains/solana.js';
import { IkaService } from '../ika/service.js';
import { getWalletState, listProposals, listSpendRequests } from '../policy/state.js';
import {
  getDynamicFieldBcs,
  getObjectJson,
  queryEventsJsonViaGraphql,
  retryRpc,
  tableIdOf,
  type SuiRpcClient,
} from '../sui/rpc.js';
import { bcs } from '@mysten/sui/bcs';
import { ChainKind, IkaCurve } from '../types.js';
import type { PolicyWalletState, SpendRequestState, AdminProposalState } from '../types.js';

export interface ChainAddressInfo {
  chainKey: string;
  kind: number;
  address: string;
  /** identity bytes recorded on-chain at setup */
  recordedHex: string | null;
  /** true when the recorded identity matches the dWallet-derived one */
  verified: boolean;
}

export interface RecoveredWallet {
  state: PolicyWalletState;
  addresses: ChainAddressInfo[];
  pendingRequests: SpendRequestState[];
  pendingProposals: AdminProposalState[];
  warnings: string[];
}

/** All wallet ids a signer belongs to, from caps + registry union. */
export async function discoverWallets(
  client: SuiRpcClient,
  packageId: string,
  registryId: string,
  signerAddress: string,
  /** GraphQL endpoint for the event-scan fallback (optional). */
  graphqlUrl?: string,
): Promise<string[]> {
  const found = new Set<string>();

  // a. SignerCap objects
  let cursor: string | null = null;
  for (;;) {
    const page: SuiClientTypes.ListOwnedObjectsResponse<{ json: true }> = await retryRpc(() =>
      client.core.listOwnedObjects({
        owner: signerAddress,
        type: `${packageId}::policy_wallet::SignerCap`,
        include: { json: true },
        cursor: cursor ?? undefined,
      }),
    );
    for (const obj of page.objects) {
      const walletId = (obj.json as { wallet_id?: string } | null)?.wallet_id;
      if (walletId) found.add(walletId);
    }
    if (!page.hasNextPage || !page.cursor) break;
    cursor = page.cursor;
  }

  // b. Registry table lookup
  try {
    const regJson = await getObjectJson(client, registryId);
    const tableId = tableIdOf(regJson.wallets_by_signer);
    const valueBcs = await getDynamicFieldBcs(
      client,
      tableId,
      'address',
      bcs.Address.serialize(signerAddress).toBytes(),
    );
    if (valueBcs) {
      const ids = bcs.vector(bcs.Address).parse(valueBcs);
      for (const id of ids) found.add(id);
    }
  } catch {
    // registry unreachable - SignerCaps and events still work
  }

  // c. event fallback (only if nothing found - slow path, GraphQL only)
  if (found.size === 0 && graphqlUrl) {
    try {
      const events = await queryEventsJsonViaGraphql(
        graphqlUrl,
        `${packageId}::events::WalletCreated`,
        200,
      );
      for (const parsed of events as { wallet_id?: string; signers?: string[] }[]) {
        if (parsed.wallet_id && parsed.signers?.includes(signerAddress)) {
          found.add(parsed.wallet_id);
        }
      }
    } catch {
      // best-effort
    }
  }

  return [...found];
}

/**
 * Full recovery of one wallet: state, per-chain addresses re-derived from
 * the Ika dWallet public outputs (source of truth), pending work.
 */
export async function recoverWallet(
  client: SuiRpcClient,
  ika: IkaService,
  walletId: string,
  btcNetwork: BtcNetwork,
): Promise<RecoveredWallet> {
  const state = await getWalletState(client, walletId);
  const warnings: string[] = [];

  // Re-derive chain identities from dWallet public keys.
  const publicKeys = new Map<number, Uint8Array>();
  for (const [curve, dwalletId] of state.dwallets) {
    try {
      const dwallet = await ika.getActiveDWallet(dwalletId);
      publicKeys.set(curve, dwallet.publicKey);
    } catch (e) {
      warnings.push(`could not fetch dWallet for curve ${curve}: ${(e as Error).message}`);
    }
  }

  const addresses: ChainAddressInfo[] = [];
  for (const [chainKey, chain] of state.chains) {
    const recorded = state.addressBook.get(chainKey) ?? null;
    let address = '';
    let derivedIdentity: Uint8Array | null = null;

    if (chain.kind === ChainKind.Btc) {
      const pk = publicKeys.get(IkaCurve.Secp256k1);
      if (pk) {
        address = deriveBtcAddress(pk, btcNetwork);
        derivedIdentity = p2wpkhScript(pk);
      }
    } else if (chain.kind === ChainKind.Evm) {
      const pk = publicKeys.get(IkaCurve.Secp256k1);
      if (pk) {
        address = deriveEvmAddress(pk);
        derivedIdentity = evmAddressBytes(address);
      }
    } else if (chain.kind === ChainKind.Solana) {
      const pk = publicKeys.get(IkaCurve.Ed25519);
      if (pk) {
        address = deriveSolanaAddress(pk);
        derivedIdentity = pk;
      }
    } else if (chain.kind === ChainKind.SuiVault) {
      address = walletId; // funds live inside the wallet object itself
    }

    let verified = chain.kind === ChainKind.SuiVault;
    if (derivedIdentity && recorded) {
      verified = bytesEqual(derivedIdentity, recorded);
      if (!verified) {
        warnings.push(
          `SECURITY: recorded identity for ${chainKey} does not match the dWallet-derived identity. ` +
            `Do not approve spends on this chain until resolved.`,
        );
      }
    } else if (derivedIdentity && !recorded) {
      warnings.push(`no recorded identity for ${chainKey}; derived ${bytesToHex(derivedIdentity)}`);
    }

    addresses.push({
      chainKey,
      kind: chain.kind,
      address,
      recordedHex: recorded ? bytesToHex(recorded) : null,
      verified,
    });
  }

  const [requests, proposals] = await Promise.all([
    listSpendRequests(client, walletId),
    listProposals(client, walletId),
  ]);

  return {
    state,
    addresses,
    pendingRequests: requests.filter((r) => r.status === 0),
    pendingProposals: proposals.filter((p) => p.status === 0),
    warnings,
  };
}
