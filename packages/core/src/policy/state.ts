/**
 * On-chain state readers. Everything here works against any standard Sui
 * RPC node - no indexer, no custom backend - which is what makes the wallet
 * recoverable when every frontend instance is gone.
 */

import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import { base64ToBytes, bytesToHex, fromUtf8, toBytes } from '../codec.js';
import type {
  AdminProposalState,
  ChainPolicyState,
  PolicyWalletState,
  SpendRequestState,
} from '../types.js';

type Json = Record<string, unknown>;

function fields(content: unknown): Json {
  const c = content as { dataType?: string; fields?: Json };
  if (!c || c.dataType !== 'moveObject' || !c.fields) throw new Error('not a move object');
  return c.fields;
}

function tableId(field: unknown): string {
  const f = (field as Json | undefined)?.fields as Json | undefined;
  const id = (f?.id as Json | undefined)?.id;
  if (typeof id !== 'string') throw new Error('not a table field');
  return id;
}

function asBytes(v: unknown): Uint8Array {
  if (typeof v === 'string') return base64ToBytes(v);
  return Uint8Array.from(v as number[]);
}

function asBig(v: unknown): bigint {
  return BigInt(v as string | number);
}

function vecSetAddresses(v: unknown): string[] {
  return (((v as Json).fields as Json).contents as string[]) ?? [];
}

function vecSetBytesHex(v: unknown): string[] {
  const contents = (((v as Json).fields as Json).contents as unknown[]) ?? [];
  return contents.map((c) => bytesToHex(asBytes(c)));
}

export async function getWalletState(
  client: SuiClient,
  walletId: string,
): Promise<PolicyWalletState> {
  const obj = await client.getObject({ id: walletId, options: { showContent: true } });
  if (!obj.data) throw new Error(`wallet ${walletId} not found`);
  const f = fields(obj.data.content);

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
  };

  // --- dwallets table: curve -> DWalletEntry { cap, dwallet_id } ---
  const dwalletsTable = tableId(f.dwallets);
  for await (const entry of iterateDynamicFields(client, dwalletsTable)) {
    const curve = Number((entry.name as Json).value);
    const value = (entry.value as Json).fields as Json;
    state.dwallets.set(curve, value.dwallet_id as string);
  }

  // --- address book: chainKey -> identity bytes ---
  const abTable = tableId(f.address_book);
  for await (const entry of iterateDynamicFields(client, abTable)) {
    const key = fromUtf8(asBytes((entry.name as Json).value));
    state.addressBook.set(key, asBytes(entry.value));
  }

  // --- chains: chainKey -> ChainPolicy ---
  const chainsTable = tableId(f.chains);
  for await (const entry of iterateDynamicFields(client, chainsTable)) {
    const key = fromUtf8(asBytes((entry.name as Json).value));
    const v = (entry.value as Json).fields as Json;
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
  const presignTable = tableId(f.presigns);
  for await (const entry of iterateDynamicFields(client, presignTable)) {
    const rawName = (entry.name as Json).value as Json;
    // struct-typed dynamic field names arrive as { type, fields: {...} }
    const kv = ((rawName.fields ?? rawName) as Json);
    const key = `${kv.curve}:${kv.signature_algorithm}`;
    const caps = (entry.value as unknown[]).map((cap) => {
      const cf = (cap as Json).fields as Json;
      return {
        capId: ((cf.id as Json).id as string),
        presignId: cf.presign_id as string,
      };
    });
    state.presignPools.set(key, caps);
  }

  return state;
}

/** Iterates a Table's dynamic fields, resolving each field's value object. */
async function* iterateDynamicFields(
  client: SuiClient,
  parentId: string,
): AsyncGenerator<{ name: unknown; value: unknown }> {
  let cursor: string | null | undefined = undefined;
  for (;;) {
    const page = await client.getDynamicFields({ parentId, cursor: cursor ?? undefined });
    for (const info of page.data) {
      const obj = await client.getDynamicFieldObject({ parentId, name: info.name });
      if (!obj.data?.content) continue;
      const f = fields(obj.data.content);
      yield { name: { value: f.name }, value: f.value };
    }
    if (!page.hasNextPage || !page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

function parseRequest(v: Json): SpendRequestState {
  const f = v;
  return {
    id: asBig(f.id),
    creator: f.creator as string,
    chainKey: fromUtf8(asBytes(f.chain_key)),
    asset: asBytes(f.asset),
    destination: asBytes(f.destination),
    amount: asBig(f.amount),
    verifiedIntent: f.verified_intent as boolean,
    messages: (f.messages as unknown[]).map(asBytes),
    aux: ((f.aux as unknown[]) ?? []).map(asBytes),
    partialSigIds: ((f.partial_sig_caps as unknown[]) ?? []).map(
      (cap) => (((cap as Json).fields as Json).partial_centralized_signed_message_id as string),
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
  client: SuiClient,
  walletId: string,
  requestId: bigint,
): Promise<SpendRequestState> {
  const obj = await client.getObject({ id: walletId, options: { showContent: true } });
  const f = fields(obj.data?.content);
  const requestsTable = tableId(f.requests);
  const field = await client.getDynamicFieldObject({
    parentId: requestsTable,
    name: { type: 'u64', value: requestId.toString() },
  });
  if (!field.data?.content) throw new Error(`request ${requestId} not found`);
  const ff = fields(field.data.content);
  return parseRequest((ff.value as Json).fields as Json);
}

export async function listSpendRequests(
  client: SuiClient,
  walletId: string,
): Promise<SpendRequestState[]> {
  const obj = await client.getObject({ id: walletId, options: { showContent: true } });
  const f = fields(obj.data?.content);
  const requestsTable = tableId(f.requests);
  const out: SpendRequestState[] = [];
  for await (const entry of iterateDynamicFields(client, requestsTable)) {
    out.push(parseRequest((entry.value as Json).fields as Json));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function parseProposal(f: Json): AdminProposalState {
  const addr = f.addr_param as string | null | undefined;
  return {
    id: asBig(f.id),
    creator: f.creator as string,
    action: Number(f.action) as AdminProposalState['action'],
    chainKey: fromUtf8(asBytes(f.chain_key)),
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
  client: SuiClient,
  walletId: string,
): Promise<AdminProposalState[]> {
  const obj = await client.getObject({ id: walletId, options: { showContent: true } });
  const f = fields(obj.data?.content);
  const proposalsTable = tableId(f.proposals);
  const out: AdminProposalState[] = [];
  for await (const entry of iterateDynamicFields(client, proposalsTable)) {
    out.push(parseProposal((entry.value as Json).fields as Json));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { toBytes };

export interface SuiVaultBalance {
  coinType: string;
  amount: bigint;
}

export async function getVaultBalances(
  client: SuiClient,
  walletId: string,
): Promise<SuiVaultBalance[]> {
  const obj = await client.getObject({ id: walletId, options: { showContent: true } });
  if (!obj.data) throw new Error(`wallet ${walletId} not found`);
  const f = fields(obj.data.content);
  const vaultId = tableId(f.vault);
  const out: SuiVaultBalance[] = [];
  for await (const entry of iterateDynamicFields(client, vaultId)) {
    out.push({
      coinType: normalizeSuiTypeName(dynamicFieldNameToString((entry.name as Json).value)),
      amount: dynamicFieldBalanceValue(entry.value),
    });
  }
  return out.sort((a, b) => a.coinType.localeCompare(b.coinType));
}

function dynamicFieldNameToString(name: unknown): string {
  if (typeof name === 'string') {
    if (name.includes('::')) return name;
    try {
      return fromUtf8(base64ToBytes(name));
    } catch {
      return name;
    }
  }
  if (Array.isArray(name)) return fromUtf8(Uint8Array.from(name as number[]));
  const f = (name as Json | undefined)?.fields as Json | undefined;
  const nested = (f?.name ?? f?.value) as unknown;
  if (nested !== undefined) return dynamicFieldNameToString(nested);
  throw new Error('unsupported vault coin type key');
}

function dynamicFieldBalanceValue(value: unknown): bigint {
  if (typeof value === 'string' || typeof value === 'number') return asBig(value);
  const f = (value as Json | undefined)?.fields as Json | undefined;
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
