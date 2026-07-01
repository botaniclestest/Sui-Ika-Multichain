/**
 * On-chain state readers. Everything here works against any standard Sui
 * RPC node - no indexer, no custom backend - which is what makes the wallet
 * recoverable when every frontend instance is gone.
 *
 * All reads go through the SDK's transport-agnostic core API, so any of
 * `SuiGrpcClient`, `SuiGraphQLClient` or the legacy `SuiJsonRpcClient`
 * works (Sui is deprecating JSON-RPC in favor of gRPC/GraphQL).
 */

import { bytesToHex, toBytes } from '../codec.js';
import { bcs } from '@mysten/sui/bcs';
import {
  asBig,
  asBytes,
  bytesToUtf8,
  getObjectJson,
  getTableEntryJson,
  iterateTableJson,
  retryRpc,
  tableIdOf,
  unwrapFields,
  vecSetContents,
  type Json,
  type SuiRpcClient,
} from '../sui/rpc.js';
import type {
  AdminProposalState,
  AssetPolicyState,
  ChainPolicyState,
  PolicyWalletState,
  SpendRequestState,
} from '../types.js';

function vecSetAddresses(v: unknown): string[] {
  return (vecSetContents(v) as string[]) ?? [];
}

function vecSetBytesHex(v: unknown): string[] {
  return vecSetContents(v).map((c) => bytesToHex(asBytes(c)));
}

/** Object id from a JSON-rendered UID (string or `{ id }`). */
function uidOf(v: unknown): string {
  if (typeof v === 'string') return v;
  const j = unwrapFields(v);
  const id = j?.id;
  if (typeof id === 'string') return id;
  const nested = (id as Json | undefined)?.id;
  if (typeof nested === 'string') return nested;
  throw new Error('unrecognized UID shape');
}

export async function getWalletState(
  client: SuiRpcClient,
  walletId: string,
): Promise<PolicyWalletState> {
  const f = await getObjectJson(client, walletId);

  const state: PolicyWalletState = {
    walletId,
    creator: f.creator as string,
    signers: f.signers as string[],
    threshold: asBig(f.threshold),
    adminThreshold: asBig(f.admin_threshold),
    timelockSpendMs: asBig(f.timelock_spend_ms),
    timelockAdminMs: asBig(f.timelock_admin_ms),
    requestExpiryMs: asBig(f.request_expiry_ms),
    paused: f.paused as boolean,
    setupComplete: f.setup_complete as boolean,
    networkEncryptionKeyId: f.network_encryption_key_id as string,
    ikaBalance: asBig(f.ika_balance ?? 0),
    suiBalance: asBig(f.sui_balance ?? 0),
    requestCounter: asBig(f.request_counter),
    proposalCounter: asBig(f.proposal_counter),
    dwallets: new Map(),
    addressBook: new Map(),
    chains: new Map(),
    presignPools: new Map(),
    assetPolicies: new Map(),
  };

  // --- dwallets table: curve -> DWalletEntry { cap, dwallet_id } ---
  const dwalletsTable = tableIdOf(f.dwallets);
  for await (const entry of iterateTableJson(client, dwalletsTable)) {
    const curve = Number(entry.name);
    const value = unwrapFields(entry.value);
    state.dwallets.set(curve, value.dwallet_id as string);
  }

  // --- address book: chainKey -> identity bytes ---
  const abTable = tableIdOf(f.address_book);
  for await (const entry of iterateTableJson(client, abTable)) {
    state.addressBook.set(bytesToUtf8(entry.name), asBytes(entry.value));
  }

  // --- chains: chainKey -> ChainPolicy ---
  const chainsTable = tableIdOf(f.chains);
  for await (const entry of iterateTableJson(client, chainsTable)) {
    const key = bytesToUtf8(entry.name);
    const v = unwrapFields(entry.value);
    const policy: ChainPolicyState = {
      chainKey: key,
      kind: Number(v.kind) as ChainPolicyState['kind'],
      enabled: v.enabled as boolean,
      evmChainId: asBig(v.evm_chain_id),
      curve: Number(v.curve),
      signatureAlgorithm: Number(v.signature_algorithm),
      hashScheme: Number(v.hash_scheme),
      fastPathLimit: asBig(v.fast_path_limit),
      perTxLimit: asBig(v.per_tx_limit),
      windowLimit: asBig(v.window_limit),
      windowMs: asBig(v.window_ms),
      spentInWindow: asBig(v.spent_in_window),
      windowStartedAtMs: asBig(v.window_started_at_ms),
      feeLimit: asBig(v.fee_limit),
      allowlistEnabled: v.allowlist_enabled as boolean,
      allowlist: vecSetBytesHex(v.allowlist),
      blocklist: vecSetBytesHex(v.blocklist),
      allowUnverified: v.allow_unverified as boolean,
    };
    state.chains.set(key, policy);
  }

  // --- presign pools: {curve, alg} -> caps (pool order) ---
  const presignTable = tableIdOf(f.presigns);
  for await (const entry of iterateTableJson(client, presignTable)) {
    const kv = unwrapFields(entry.name);
    const key = `${kv.curve}:${kv.signature_algorithm}`;
    const caps = ((entry.value as unknown[]) ?? []).map((cap) => {
      const cf = unwrapFields(cap);
      return {
        capId: uidOf(cf.id),
        presignId: cf.presign_id as string,
      };
    });
    state.presignPools.set(key, caps);
  }

  // --- per-asset limit overrides: dynamic fields on the wallet UID ---
  // (AssetPolicyKey { chain_key, asset } -> AssetPolicy). Tables live in
  // their own child objects, so the wallet UID's direct dynamic fields are
  // exactly the asset policies.
  try {
    for await (const entry of iterateWalletAssetPolicies(client, walletId)) {
      state.assetPolicies.set(assetPolicyMapKey(entry.chainKey, entry.assetHex), entry);
    }
  } catch {
    // pre-upgrade packages have no asset policies; ignore
  }

  return state;
}

export function assetPolicyMapKey(chainKey: string, assetHex: string): string {
  return `${chainKey}:${assetHex}`;
}

async function* iterateWalletAssetPolicies(
  client: SuiRpcClient,
  walletId: string,
): AsyncGenerator<AssetPolicyState> {
  let cursor: string | null = null;
  for (;;) {
    const page = await retryRpc(() =>
      client.core.listDynamicFields({ parentId: walletId, cursor: cursor ?? undefined }),
    );
    for (const df of page.dynamicFields) {
      if (!df.name.type.endsWith('::policy_wallet::AssetPolicyKey')) continue;
      let fieldJson: Json;
      try {
        fieldJson = await getObjectJson(client, df.fieldId);
      } catch {
        continue;
      }
      const name = unwrapFields(fieldJson.name);
      const v = unwrapFields(fieldJson.value);
      yield {
        chainKey: bytesToUtf8(name.chain_key),
        assetHex: bytesToHex(asBytes(name.asset)),
        fastPathLimit: asBig(v.fast_path_limit),
        perTxLimit: asBig(v.per_tx_limit),
        windowLimit: asBig(v.window_limit),
        windowMs: asBig(v.window_ms),
        spentInWindow: asBig(v.spent_in_window),
        windowStartedAtMs: asBig(v.window_started_at_ms),
      };
    }
    if (!page.hasNextPage || !page.cursor) return;
    cursor = page.cursor;
  }
}

function parseRequest(v: Json): SpendRequestState {
  const f = v;
  return {
    id: asBig(f.id),
    creator: f.creator as string,
    chainKey: bytesToUtf8(f.chain_key),
    asset: asBytes(f.asset),
    destination: asBytes(f.destination),
    amount: asBig(f.amount),
    verifiedIntent: f.verified_intent as boolean,
    messages: (f.messages as unknown[]).map(asBytes),
    aux: ((f.aux as unknown[]) ?? []).map(asBytes),
    partialSigIds: ((f.partial_sig_caps as unknown[]) ?? []).map(
      (cap) => unwrapFields(cap).partial_centralized_signed_message_id as string,
    ),
    curve: Number(f.curve),
    signatureAlgorithm: Number(f.signature_algorithm),
    hashScheme: Number(f.hash_scheme),
    approvals: vecSetAddresses(f.approvals),
    rejections: vecSetAddresses(f.rejections),
    createdAtMs: asBig(f.created_at_ms),
    thresholdReachedAtMs: asBig(f.threshold_reached_at_ms),
    status: Number(f.status) as SpendRequestState['status'],
    signIds: (f.sign_ids as string[]) ?? [],
  };
}

export async function getSpendRequest(
  client: SuiRpcClient,
  walletId: string,
  requestId: bigint,
): Promise<SpendRequestState> {
  const f = await getObjectJson(client, walletId);
  const requestsTable = tableIdOf(f.requests);
  const entry = await getTableEntryJson(
    client,
    requestsTable,
    'u64',
    bcs.u64().serialize(requestId).toBytes(),
  );
  if (!entry) throw new Error(`request ${requestId} not found`);
  return parseRequest(unwrapFields(entry.value));
}

export async function listSpendRequests(
  client: SuiRpcClient,
  walletId: string,
): Promise<SpendRequestState[]> {
  const f = await getObjectJson(client, walletId);
  const requestsTable = tableIdOf(f.requests);
  const out: SpendRequestState[] = [];
  for await (const entry of iterateTableJson(client, requestsTable)) {
    out.push(parseRequest(unwrapFields(entry.value)));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function parseProposal(f: Json): AdminProposalState {
  const addr = f.addr_param as string | null | undefined;
  return {
    id: asBig(f.id),
    creator: f.creator as string,
    action: Number(f.action) as AdminProposalState['action'],
    chainKey: bytesToUtf8(f.chain_key),
    addrParam: addr ?? null,
    bytesParam: asBytes(f.bytes_param),
    uParams: (f.u_params as unknown[]).map(asBig),
    boolParam: f.bool_param as boolean,
    approvals: vecSetAddresses(f.approvals),
    rejections: vecSetAddresses(f.rejections),
    createdAtMs: asBig(f.created_at_ms),
    thresholdReachedAtMs: asBig(f.threshold_reached_at_ms),
    status: Number(f.status) as AdminProposalState['status'],
  };
}

export async function listProposals(
  client: SuiRpcClient,
  walletId: string,
): Promise<AdminProposalState[]> {
  const f = await getObjectJson(client, walletId);
  const proposalsTable = tableIdOf(f.proposals);
  const out: AdminProposalState[] = [];
  for await (const entry of iterateTableJson(client, proposalsTable)) {
    out.push(parseProposal(unwrapFields(entry.value)));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { toBytes };

export interface SuiVaultBalance {
  coinType: string;
  amount: bigint;
}

export async function getVaultBalances(
  client: SuiRpcClient,
  walletId: string,
): Promise<SuiVaultBalance[]> {
  const f = await getObjectJson(client, walletId);
  const vaultId = tableIdOf(f.vault);
  const out: SuiVaultBalance[] = [];
  for await (const entry of iterateTableJson(client, vaultId)) {
    out.push({
      coinType: normalizeSuiTypeName(dynamicFieldNameToString(entry.name)),
      amount: dynamicFieldBalanceValue(entry.value),
    });
  }
  return out.sort((a, b) => a.coinType.localeCompare(b.coinType));
}

function dynamicFieldNameToString(name: unknown): string {
  if (typeof name === 'string') {
    if (name.includes('::')) return name;
    try {
      return bytesToUtf8(name);
    } catch {
      return name;
    }
  }
  if (Array.isArray(name)) return bytesToUtf8(name);
  const f = unwrapFields(name) as Json | undefined;
  const nested = (f?.name ?? f?.value) as unknown;
  if (nested !== undefined) return dynamicFieldNameToString(nested);
  throw new Error('unsupported vault coin type key');
}

function dynamicFieldBalanceValue(value: unknown): bigint {
  if (typeof value === 'string' || typeof value === 'number') return asBig(value);
  const f = unwrapFields(value) as Json | undefined;
  const nested = f?.value ?? (value as Json | undefined)?.value;
  if (nested === undefined) throw new Error('unsupported vault balance value');
  return dynamicFieldBalanceValue(nested);
}

function normalizeSuiTypeName(typeName: string): string {
  return typeName.replace(/^(0x)?([0-9a-fA-F]{64})(::)/, (_match, _prefix, addr, sep) => {
    const short = BigInt(`0x${addr}`).toString(16);
    return `0x${short}${sep}`;
  });
}
