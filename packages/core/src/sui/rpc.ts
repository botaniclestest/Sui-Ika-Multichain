/**
 * Transport-agnostic Sui RPC access.
 *
 * Sui is deprecating JSON-RPC in favor of gRPC (fullnodes) and GraphQL
 * (indexer). Everything in this package therefore talks to the node through
 * the SDK's *core API* (`client.core`), which is implemented identically by
 * `SuiGrpcClient`, `SuiGraphQLClient` and the legacy `SuiJsonRpcClient`.
 * Callers may hand us any of the three.
 *
 * The helpers below normalize the small shape differences in the JSON
 * rendering of Move values that the different transports produce, so the
 * state readers can stay transport-independent.
 */

import type { ClientWithCoreApi } from '@mysten/sui/client';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { base64ToBytes, fromUtf8 } from '../codec.js';

/** Any Sui client exposing the transport-agnostic core API. */
export type SuiRpcClient = ClientWithCoreApi;

export type Json = Record<string, unknown>;

/** True for transient rate-limit / unavailable errors worth retrying. */
function isTransientRpcError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message} ${(e as { code?: string }).code ?? ''}` : String(e);
  return /429|Too Many Requests|RESOURCE_EXHAUSTED|UNAVAILABLE|503|ECONNRESET|fetch failed/i.test(msg);
}

/**
 * Retries a call on transient rate-limit errors with exponential backoff.
 * Public fullnodes rate-limit aggressively; recovery reads fan out over
 * many dynamic fields, so all helpers below go through this.
 */
export async function retryRpc<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isTransientRpcError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastError;
}

/** Fetches an object's Move struct content as JSON (throws when missing). */
export async function getObjectJson(client: SuiRpcClient, objectId: string): Promise<Json> {
  const res = await retryRpc(() => client.core.getObject({ objectId, include: { json: true } }));
  const json = res.object.json;
  if (!json) throw new Error(`object ${objectId} has no JSON content`);
  return json as Json;
}

/** Like {@link getObjectJson} but returns null instead of throwing. */
export async function tryGetObjectJson(client: SuiRpcClient, objectId: string): Promise<Json | null> {
  try {
    return await getObjectJson(client, objectId);
  } catch {
    return null;
  }
}

/**
 * Extracts the object id of a Table/Bag/ObjectTable handle from a parent
 * object's JSON. gRPC/GraphQL render handles as `{ id, size }`; the legacy
 * JSON-RPC rendering nests it as `{ fields: { id: { id } } }`.
 */
export function tableIdOf(handle: unknown): string {
  const h = handle as Json | undefined;
  if (!h) throw new Error('missing table handle');
  if (typeof h.id === 'string') return h.id;
  const nestedId = (h.id as Json | undefined)?.id;
  if (typeof nestedId === 'string') return nestedId;
  const f = h.fields as Json | undefined;
  const fid = (f?.id as Json | undefined)?.id;
  if (typeof fid === 'string') return fid;
  throw new Error('unrecognized table handle shape');
}

/** Unwraps a `{ type, fields }` wrapper if present (legacy JSON-RPC shape). */
export function unwrapFields(v: unknown): Json {
  const j = v as Json;
  if (j && typeof j === 'object' && 'fields' in j && j.fields && typeof j.fields === 'object') {
    return j.fields as Json;
  }
  return j;
}

/** VecSet<T> contents across transports: `{ contents }` or `{ fields: { contents } }`. */
export function vecSetContents(v: unknown): unknown[] {
  const j = unwrapFields(v);
  return (j?.contents as unknown[]) ?? [];
}

/** Move `vector<u8>` values arrive as base64 strings (gRPC/GraphQL) or number arrays. */
export function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return base64ToBytes(v);
  return Uint8Array.from(v as number[]);
}

export function asBig(v: unknown): bigint {
  return BigInt(v as string | number);
}

/** Decodes a `vector<u8>` chain key / name into a UTF-8 string. */
export function bytesToUtf8(v: unknown): string {
  return fromUtf8(asBytes(v));
}

export interface TableEntryJson {
  /** Dynamic field name as rendered in the Field object's JSON. */
  name: unknown;
  /** Dynamic field value as rendered in the Field object's JSON. */
  value: unknown;
}

/**
 * Iterates a Table/Bag's `Field<K, V>` entries, yielding each field's
 * JSON-rendered name and value. Works over any core-API client.
 */
export async function* iterateTableJson(
  client: SuiRpcClient,
  parentId: string,
): AsyncGenerator<TableEntryJson> {
  let cursor: string | null = null;
  for (;;) {
    const page = await retryRpc(() =>
      client.core.listDynamicFields({ parentId, cursor: cursor ?? undefined }),
    );
    for (const entry of page.dynamicFields) {
      const json = await tryGetObjectJson(client, entry.fieldId);
      if (!json) continue;
      yield { name: json.name, value: json.value };
    }
    if (!page.hasNextPage || !page.cursor) return;
    cursor = page.cursor;
  }
}

/**
 * Fetches one Table entry's Field JSON by name, without listing the table.
 * `nameType` is the Move type of the key (e.g. `u64`, `address`), and
 * `nameBcs` its BCS serialization.
 */
export async function getTableEntryJson(
  client: SuiRpcClient,
  parentId: string,
  nameType: string,
  nameBcs: Uint8Array,
): Promise<TableEntryJson | null> {
  const fieldId = deriveDynamicFieldID(parentId, nameType, nameBcs);
  const json = await tryGetObjectJson(client, fieldId);
  if (!json) return null;
  return { name: json.name, value: json.value };
}

/**
 * Reads a dynamic field's raw BCS value (used where BCS parsing is simpler
 * than JSON, e.g. `vector<ID>` registry entries).
 */
export async function getDynamicFieldBcs(
  client: SuiRpcClient,
  parentId: string,
  nameType: string,
  nameBcs: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const res = await retryRpc(() =>
      client.core.getDynamicField({
        parentId,
        name: { type: nameType, bcs: nameBcs },
      }),
    );
    return res.dynamicField.value.bcs;
  } catch {
    return null;
  }
}

/**
 * Minimal GraphQL event query used only as a last-resort discovery
 * fallback (the core API has no transport-agnostic event query yet).
 * Talks straight to a Sui GraphQL endpoint over fetch.
 */
export async function queryEventsJsonViaGraphql(
  graphqlUrl: string,
  eventType: string,
  last = 50,
): Promise<Json[]> {
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'query($t: String!, $n: Int!) { events(last: $n, filter: { type: $t }) { nodes { contents { json } } } }',
      variables: { t: eventType, n: last },
    }),
  });
  if (!res.ok) throw new Error(`GraphQL event query failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: { events?: { nodes?: { contents?: { json?: Json } }[] } };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return (body.data?.events?.nodes ?? [])
    .map((n) => n.contents?.json)
    .filter((j): j is Json => !!j);
}
