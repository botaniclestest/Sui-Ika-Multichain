/**
 * Bitcoin chain adapter (P2WPKH, segwit v0).
 *
 * Responsibilities:
 *  - derive the wallet's BTC address/scriptPubKey from the dWallet pubkey
 *  - build an unsigned transaction + the exact BIP-143 preimages the
 *    on-chain verifier (`verify_btc.move`) checks and Ika signs
 *  - assemble the final witness transaction from Ika's 64-byte signatures
 *  - talk to an Esplora endpoint for UTXOs/broadcast
 *
 * The preimages built here are byte-identical to what the Move contract
 * parses: SIGHASH_ALL only, scriptCode bound to our own pubkey hash, first
 * output = destination, optional second output = change back to self.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import {
  btcVarint,
  bytesEqual,
  bytesToHex,
  concatBytes,
  hexToBytes,
  u32le,
  u64le,
} from '../codec.js';

export type BtcNetwork = 'mainnet' | 'testnet';

const HRP: Record<BtcNetwork, string> = { mainnet: 'bc', testnet: 'tb' };
const SIGHASH_ALL = 1;
const SEQUENCE_RBF = 0xfffffffd;
const TX_VERSION = 2;
const DUST_SATS = 294n;

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmed: boolean;
}

export interface BtcAssembly {
  inputs: { txid: string; vout: number; value: bigint; sequence: number }[];
  outputs: { value: bigint; scriptPubKey: string }[];
  version: number;
  locktime: number;
  publicKeyHex: string;
}

export interface BtcSpendPlan {
  messages: Uint8Array[]; // BIP-143 preimages, one per input
  outputsBytes: Uint8Array;
  prevoutsBytes: Uint8Array;
  fee: bigint;
  assembly: BtcAssembly;
}

// === key / address derivation ===

export function compressPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === 33) return publicKey;
  return secp256k1.Point.fromBytes(publicKey).toBytes(true);
}

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** P2WPKH scriptPubKey: OP_0 PUSH20 <hash160(pubkey)>. */
export function p2wpkhScript(publicKey: Uint8Array): Uint8Array {
  const pkh = hash160(compressPublicKey(publicKey));
  return concatBytes(new Uint8Array([0x00, 0x14]), pkh);
}

export function deriveBtcAddress(publicKey: Uint8Array, network: BtcNetwork): string {
  const pkh = hash160(compressPublicKey(publicKey));
  const words = bech32.toWords(pkh);
  return bech32.encode(HRP[network], [0, ...words]);
}

/** Decodes a bech32 segwit v0 P2WPKH/P2WSH address into its scriptPubKey. */
export function addressToScript(address: string, network: BtcNetwork): Uint8Array {
  const decoded = bech32.decode(address as `${string}1${string}`);
  if (decoded.prefix !== HRP[network]) {
    throw new Error(`address ${address} is not for ${network}`);
  }
  const [version, ...words] = decoded.words;
  if (version !== 0) throw new Error('only segwit v0 destinations supported in v1');
  const program = Uint8Array.from(bech32.fromWords(words));
  if (program.length !== 20 && program.length !== 32) throw new Error('bad witness program');
  return concatBytes(new Uint8Array([0x00, program.length]), program);
}

// === transaction planning ===

export function selectUtxos(
  utxos: Utxo[],
  target: bigint,
  feeRateSatVb: bigint,
): { selected: Utxo[]; fee: bigint } {
  const sorted = [...utxos]
    .filter((u) => u.confirmed)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected: Utxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    const fee = estimateFee(selected.length, 2, feeRateSatVb);
    if (total >= target + fee) return { selected, fee };
  }
  throw new Error('insufficient confirmed BTC balance');
}

export function estimateFee(nInputs: number, nOutputs: number, feeRateSatVb: bigint): bigint {
  // P2WPKH: ~68 vB per input, 31 vB per output, 10.5 vB overhead.
  const vbytes = BigInt(11 + 68 * nInputs + 31 * nOutputs);
  return vbytes * feeRateSatVb;
}

/**
 * Builds the unsigned spend: messages (BIP-143 preimages) + the aux bytes
 * the Move verifier needs + everything required to assemble the final tx.
 */
export function buildBtcSpend(params: {
  utxos: Utxo[];
  publicKey: Uint8Array;
  destinationScript: Uint8Array;
  amount: bigint;
  feeRateSatVb: bigint;
  network: BtcNetwork;
}): BtcSpendPlan {
  const { utxos, publicKey, destinationScript, amount, feeRateSatVb } = params;
  if (amount < DUST_SATS) throw new Error('amount below dust threshold');
  const ownScript = p2wpkhScript(publicKey);
  const { selected, fee } = selectUtxos(utxos, amount, feeRateSatVb);

  const totalIn = selected.reduce((acc, u) => acc + u.value, 0n);
  const change = totalIn - amount - fee;
  const outputs: { value: bigint; scriptPubKey: string }[] = [
    { value: amount, scriptPubKey: bytesToHex(destinationScript) },
  ];
  if (change >= DUST_SATS) {
    outputs.push({ value: change, scriptPubKey: bytesToHex(ownScript) });
  }
  // if change < dust it is silently added to the fee

  const inputs = selected.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    sequence: SEQUENCE_RBF,
  }));

  const prevoutsBytes = concatBytes(
    ...inputs.map((i) => concatBytes(hexToBytes(i.txid).reverse(), u32le(i.vout))),
  );
  const sequencesBytes = concatBytes(...inputs.map((i) => u32le(i.sequence)));
  const outputsBytes = concatBytes(
    ...outputs.map((o) => serializeOutput(o.value, hexToBytes(o.scriptPubKey))),
  );

  const hashPrevouts = dsha256(prevoutsBytes);
  const hashSequence = dsha256(sequencesBytes);
  const hashOutputs = dsha256(outputsBytes);
  const scriptCode = p2pkhScriptCode(ownScript);

  const messages = inputs.map((input, idx) =>
    concatBytes(
      u32le(TX_VERSION),
      hashPrevouts,
      hashSequence,
      prevoutsBytes.slice(idx * 36, idx * 36 + 36),
      scriptCode,
      u64le(input.value),
      u32le(input.sequence),
      hashOutputs,
      u32le(0), // locktime
      u32le(SIGHASH_ALL),
    ),
  );

  return {
    messages,
    outputsBytes,
    prevoutsBytes,
    fee: totalIn - outputs.reduce((acc, o) => acc + o.value, 0n),
    assembly: {
      inputs,
      outputs,
      version: TX_VERSION,
      locktime: 0,
      publicKeyHex: bytesToHex(compressPublicKey(publicKey)),
    },
  };
}

function serializeOutput(value: bigint, script: Uint8Array): Uint8Array {
  return concatBytes(u64le(value), btcVarint(script.length), script);
}

/** scriptCode for P2WPKH per BIP-143: varint(25) 76 a9 14 <pkh> 88 ac. */
function p2pkhScriptCode(ownScript: Uint8Array): Uint8Array {
  const pkh = ownScript.slice(2);
  return concatBytes(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    pkh,
    new Uint8Array([0x88, 0xac]),
  );
}

// === signature assembly ===

/** Normalizes a 64-byte r||s signature to low-S and DER-encodes it. */
export function toDerLowS(signature64: Uint8Array): Uint8Array {
  if (signature64.length !== 64) throw new Error('expected 64-byte compact signature');
  const r = bytesToBigInt(signature64.slice(0, 32));
  let s = bytesToBigInt(signature64.slice(32, 64));
  const n = secp256k1.Point.CURVE().n;
  if (s > n / 2n) s = n - s;
  return derEncode(r, s);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntToMinimalBytes(v: bigint): Uint8Array {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = hexToBytes(hex);
  // DER integers are signed: prepend 0x00 if the MSB is set.
  if (bytes[0] & 0x80) bytes = concatBytes(new Uint8Array([0]), bytes);
  return bytes;
}

function derEncode(r: bigint, s: bigint): Uint8Array {
  const rb = bigIntToMinimalBytes(r);
  const sb = bigIntToMinimalBytes(s);
  const body = concatBytes(
    new Uint8Array([0x02, rb.length]),
    rb,
    new Uint8Array([0x02, sb.length]),
    sb,
  );
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

/**
 * Verifies each Ika signature against its preimage digest and assembles the
 * fully-signed segwit transaction (hex), ready to broadcast.
 */
export function assembleBtcTransaction(
  assembly: BtcAssembly,
  messages: Uint8Array[],
  signatures: Uint8Array[],
): string {
  if (signatures.length !== assembly.inputs.length) {
    throw new Error('signature count != input count');
  }
  const pubkey = hexToBytes(assembly.publicKeyHex);

  const witnesses = signatures.map((sig, i) => {
    const digest = dsha256(messages[i]);
    if (!secp256k1.verify(sig, digest, pubkey, { prehash: false })) {
      throw new Error(`signature ${i} does not verify against its sighash`);
    }
    const der = toDerLowS(sig);
    return [concatBytes(der, new Uint8Array([SIGHASH_ALL])), pubkey];
  });

  const parts: Uint8Array[] = [];
  parts.push(u32le(assembly.version));
  parts.push(new Uint8Array([0x00, 0x01])); // segwit marker + flag
  parts.push(btcVarint(assembly.inputs.length));
  for (const input of assembly.inputs) {
    parts.push(hexToBytes(input.txid).reverse());
    parts.push(u32le(input.vout));
    parts.push(btcVarint(0)); // empty scriptSig
    parts.push(u32le(input.sequence));
  }
  parts.push(btcVarint(assembly.outputs.length));
  for (const output of assembly.outputs) {
    parts.push(serializeOutput(output.value, hexToBytes(output.scriptPubKey)));
  }
  for (const witness of witnesses) {
    parts.push(btcVarint(witness.length));
    for (const item of witness) {
      parts.push(btcVarint(item.length));
      parts.push(item);
    }
  }
  parts.push(u32le(assembly.locktime));
  return bytesToHex(concatBytes(...parts));
}

/** Sanity check: recorded on-chain identity must match the derived script. */
export function checkRecordedScript(publicKey: Uint8Array, recorded: Uint8Array): boolean {
  return bytesEqual(p2wpkhScript(publicKey), recorded);
}

/**
 * Reconstructs the full transaction-assembly context from ON-CHAIN request
 * data alone (the BIP-143 preimages + the stored aux outputs bytes), so any
 * signer on any machine can finalize and broadcast once Ika signs.
 */
export function btcAssemblyFromRequest(
  messages: Uint8Array[],
  aux: Uint8Array[],
  publicKey: Uint8Array,
): BtcAssembly {
  if (messages.length === 0) throw new Error('no messages');
  if (aux.length < 1) throw new Error('missing aux outputs bytes');
  const outputsBytes = aux[0];

  const inputs = messages.map((preimage) => {
    const view = new DataView(preimage.buffer, preimage.byteOffset);
    const outpoint = preimage.slice(4 + 32 + 32, 4 + 32 + 32 + 36);
    const txid = bytesToHex(outpoint.slice(0, 32).reverse());
    const vout = new DataView(outpoint.buffer, outpoint.byteOffset + 32).getUint32(0, true);
    // version(4) hashPrevouts(32) hashSequence(32) outpoint(36) scriptCode(26) amount(8) sequence(4)
    const amountOffset = 4 + 32 + 32 + 36 + 26;
    const value = view.getBigUint64(amountOffset, true);
    const sequence = view.getUint32(amountOffset + 8, true);
    return { txid, vout, value, sequence };
  });

  const version = new DataView(messages[0].buffer, messages[0].byteOffset).getUint32(0, true);
  const m0 = messages[0];
  const locktimeOffset = m0.length - 8;
  const locktime = new DataView(m0.buffer, m0.byteOffset + locktimeOffset).getUint32(0, true);

  const outputs: { value: bigint; scriptPubKey: string }[] = [];
  let p = 0;
  const dv = new DataView(outputsBytes.buffer, outputsBytes.byteOffset);
  while (p < outputsBytes.length) {
    const value = dv.getBigUint64(p, true);
    p += 8;
    const len = outputsBytes[p];
    p += 1;
    if (len >= 0xfd) throw new Error('unsupported output script length');
    outputs.push({ value, scriptPubKey: bytesToHex(outputsBytes.slice(p, p + len)) });
    p += len;
  }

  return {
    inputs,
    outputs,
    version,
    locktime,
    publicKeyHex: bytesToHex(compressPublicKey(publicKey)),
  };
}

// === Esplora I/O ===

export async function fetchUtxos(esploraUrl: string, address: string): Promise<Utxo[]> {
  const res = await fetch(`${esploraUrl}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`esplora utxo fetch failed: ${res.status}`);
  const raw = (await res.json()) as {
    txid: string;
    vout: number;
    value: number;
    status: { confirmed: boolean };
  }[];
  return raw.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    confirmed: u.status.confirmed,
  }));
}

export async function fetchBtcBalance(
  esploraUrl: string,
  address: string,
): Promise<{ confirmed: bigint; unconfirmed: bigint; total: bigint }> {
  const utxos = await fetchUtxos(esploraUrl, address);
  let confirmed = 0n;
  let unconfirmed = 0n;
  for (const utxo of utxos) {
    if (utxo.confirmed) confirmed += utxo.value;
    else unconfirmed += utxo.value;
  }
  return { confirmed, unconfirmed, total: confirmed + unconfirmed };
}

export async function fetchFeeRate(esploraUrl: string): Promise<bigint> {
  try {
    const res = await fetch(`${esploraUrl}/fee-estimates`);
    if (!res.ok) return 2n;
    const estimates = (await res.json()) as Record<string, number>;
    const rate = estimates['3'] ?? estimates['6'] ?? 2;
    return BigInt(Math.max(1, Math.ceil(rate)));
  } catch {
    return 2n;
  }
}

export async function broadcastBtc(esploraUrl: string, txHex: string): Promise<string> {
  const res = await fetch(`${esploraUrl}/tx`, { method: 'POST', body: txHex });
  const body = await res.text();
  if (!res.ok) throw new Error(`broadcast failed: ${body}`);
  return body.trim(); // txid
}
