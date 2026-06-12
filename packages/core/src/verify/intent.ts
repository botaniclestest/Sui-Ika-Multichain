/**
 * Client-side intent verification.
 *
 * Every signer's client MUST run these checks against the on-chain request
 * (exact message bytes + declared intent) before approving. For verified
 * chains this duplicates `verify_btc/evm/solana.move` (defense in depth /
 * malicious-package-upgrade detection); for UNVERIFIED payloads this is the
 * ONLY line of defense, so the human must be shown the decoded payload.
 */

import { Transaction as EthersTransaction, getAddress } from 'ethers';
import { bytesEqual, bytesToHex, concatBytes, hexToBytes } from '../codec.js';
import { dsha256 } from '../chains/btc.js';

export interface IntentCheckResult {
  ok: boolean;
  errors: string[];
  summary: string;
}

// === BTC ===

export function checkBtcIntent(params: {
  messages: Uint8Array[];
  outputsBytes: Uint8Array;
  prevoutsBytes: Uint8Array;
  ownScript: Uint8Array;
  destinationScript: Uint8Array;
  amount: bigint;
  feeLimit: bigint;
}): IntentCheckResult {
  const errors: string[] = [];
  const { messages, outputsBytes, prevoutsBytes, ownScript, destinationScript, amount, feeLimit } =
    params;

  if (messages.length === 0) errors.push('no inputs');
  if (prevoutsBytes.length !== messages.length * 36) errors.push('prevouts/input count mismatch');

  const hashPrevouts = dsha256(prevoutsBytes);
  const hashOutputs = dsha256(outputsBytes);
  const expectedScriptCode = concatBytes(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]),
    ownScript.slice(2),
    new Uint8Array([0x88, 0xac]),
  );

  let totalIn = 0n;
  messages.forEach((preimage, idx) => {
    if (preimage.length < 4 + 32 + 32 + 36 + 26 + 8 + 4 + 32 + 4 + 4) {
      errors.push(`input ${idx}: preimage too short`);
      return;
    }
    const view = new DataView(preimage.buffer, preimage.byteOffset);
    let o = 4; // version
    const hp = preimage.slice(o, o + 32);
    o += 32;
    o += 32; // hashSequence
    const outpoint = preimage.slice(o, o + 36);
    o += 36;
    const scriptCode = preimage.slice(o, o + 26);
    o += 26;
    const inputValue = view.getBigUint64(o, true);
    o += 8;
    o += 4; // sequence
    const ho = preimage.slice(o, o + 32);
    o += 32;
    o += 4; // locktime
    const sighashType = view.getUint32(o, true);
    o += 4;
    if (o !== preimage.length) errors.push(`input ${idx}: trailing bytes`);
    if (sighashType !== 1) errors.push(`input ${idx}: sighash != SIGHASH_ALL`);
    if (!bytesEqual(hp, hashPrevouts)) errors.push(`input ${idx}: hashPrevouts mismatch`);
    if (!bytesEqual(ho, hashOutputs)) errors.push(`input ${idx}: hashOutputs mismatch`);
    if (!bytesEqual(scriptCode, expectedScriptCode))
      errors.push(`input ${idx}: scriptCode not bound to wallet key`);
    if (!bytesEqual(outpoint, prevoutsBytes.slice(idx * 36, idx * 36 + 36)))
      errors.push(`input ${idx}: outpoint mismatch`);
    totalIn += inputValue;
  });

  // parse outputs
  let totalOut = 0n;
  const outputs: { value: bigint; script: Uint8Array }[] = [];
  let p = 0;
  const dv = new DataView(outputsBytes.buffer, outputsBytes.byteOffset);
  while (p < outputsBytes.length) {
    const value = dv.getBigUint64(p, true);
    p += 8;
    const len = outputsBytes[p];
    p += 1;
    if (len >= 0xfd) {
      errors.push('unsupported varint in outputs');
      break;
    }
    const script = outputsBytes.slice(p, p + len);
    p += len;
    outputs.push({ value, script });
    totalOut += value;
  }
  if (outputs.length < 1 || outputs.length > 2) errors.push('must have 1-2 outputs');
  if (outputs[0] && !bytesEqual(outputs[0].script, destinationScript))
    errors.push('output 0 is not the declared destination');
  if (outputs[0] && outputs[0].value !== amount) errors.push('output 0 amount mismatch');
  if (outputs[1] && !bytesEqual(outputs[1].script, ownScript))
    errors.push('change does not return to wallet');

  const fee = totalIn - totalOut;
  if (fee < 0n) errors.push('outputs exceed inputs');
  if (fee > feeLimit) errors.push(`fee ${fee} exceeds limit ${feeLimit}`);

  return {
    ok: errors.length === 0,
    errors,
    summary: `BTC spend: ${amount} sats -> ${bytesToHex(destinationScript)}, fee ${fee} sats, ${messages.length} input(s)`,
  };
}

// === EVM ===

export function checkEvmIntent(params: {
  message: Uint8Array;
  chainId: bigint;
  asset: Uint8Array; // empty = native
  destination: Uint8Array;
  amount: bigint;
  feeLimit: bigint;
}): IntentCheckResult {
  const errors: string[] = [];
  const { message, chainId, asset, destination, amount, feeLimit } = params;
  let summary = 'EVM spend';
  try {
    const tx = EthersTransaction.from(bytesToHex(message, true));
    if (tx.type !== 2) errors.push('not an EIP-1559 transaction');
    if (tx.chainId !== chainId) errors.push(`chainId ${tx.chainId} != policy ${chainId}`);
    const gasCost = (tx.maxFeePerGas ?? 0n) * (tx.gasLimit ?? 0n);
    if (gasCost > feeLimit) errors.push(`max gas cost ${gasCost} exceeds fee limit ${feeLimit}`);
    if (tx.to == null) errors.push('contract creation not allowed');

    const destAddr = getAddress(bytesToHex(destination, true));
    if (asset.length === 0) {
      if (tx.data !== '0x') errors.push('native transfer must not carry calldata');
      if (tx.to && getAddress(tx.to) !== destAddr) errors.push('recipient mismatch');
      if (tx.value !== amount) errors.push(`value ${tx.value} != declared ${amount}`);
      summary = `EVM native: ${amount} wei -> ${destAddr} on chain ${chainId}`;
    } else {
      const tokenAddr = getAddress(bytesToHex(asset, true));
      if (tx.to && getAddress(tx.to) !== tokenAddr) errors.push('token contract mismatch');
      if (tx.value !== 0n) errors.push('ERC-20 transfer must carry zero ETH value');
      const data = tx.data.toLowerCase();
      if (!data.startsWith('0xa9059cbb') || data.length !== 2 + 8 + 128) {
        errors.push('calldata is not transfer(address,uint256)');
      } else {
        const recipient = getAddress(`0x${data.slice(10 + 24, 10 + 64)}`);
        const value = BigInt(`0x${data.slice(10 + 64)}`);
        if (recipient !== destAddr) errors.push('token recipient mismatch');
        if (value !== amount) errors.push(`token amount ${value} != declared ${amount}`);
      }
      summary = `ERC-20: ${amount} of ${tokenAddr} -> ${destAddr} on chain ${chainId}`;
    }
  } catch (e) {
    errors.push(`failed to parse transaction: ${(e as Error).message}`);
  }
  return { ok: errors.length === 0, errors, summary };
}

// === Solana ===

const SYSVAR_RECENT_BLOCKHASHES = hexToBytes(
  '06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000',
);

export function checkSolIntent(params: {
  message: Uint8Array;
  ownPubkey: Uint8Array;
  destination: Uint8Array;
  amount: bigint;
}): IntentCheckResult {
  const errors: string[] = [];
  const { message, ownPubkey, destination, amount } = params;
  let durable = false;
  try {
    let o = 0;
    const numRequired = message[o++];
    if (numRequired & 0x80) throw new Error('versioned message');
    if (numRequired !== 1) errors.push('must have exactly 1 required signer');
    o += 2; // readonly counts
    const nAccounts = readShortvec(message, o);
    o = nAccounts.offset;
    const accounts: Uint8Array[] = [];
    for (let i = 0; i < nAccounts.value; i++) {
      accounts.push(message.slice(o, o + 32));
      o += 32;
    }
    o += 32; // blockhash / nonce value
    const nInstr = readShortvec(message, o);
    o = nInstr.offset;
    if (nInstr.value !== 1 && nInstr.value !== 2)
      errors.push('must contain 1 (transfer) or 2 (nonce advance + transfer) instructions');
    durable = nInstr.value === 2;

    const isSystem = (idx: number) =>
      accounts[idx] !== undefined && accounts[idx].every((b) => b === 0);

    if (durable) {
      // instruction 0: AdvanceNonceAccount with the wallet as authority
      const programIdx = message[o++];
      if (!isSystem(programIdx)) errors.push('nonce advance program is not SystemProgram');
      const nIx = readShortvec(message, o);
      o = nIx.offset;
      if (nIx.value !== 3) errors.push('nonce advance must reference 3 accounts');
      o++; // nonce account index (any)
      const sysvarIdx = message[o++];
      const authIdx = message[o++];
      if (!bytesEqual(accounts[sysvarIdx] ?? new Uint8Array(), SYSVAR_RECENT_BLOCKHASHES))
        errors.push('nonce advance sysvar mismatch');
      if (!bytesEqual(accounts[authIdx] ?? new Uint8Array(), ownPubkey))
        errors.push('nonce authority is not the wallet');
      const dataLen = readShortvec(message, o);
      o = dataLen.offset;
      if (dataLen.value !== 4) errors.push('nonce advance data malformed');
      const dv0 = new DataView(message.buffer, message.byteOffset + o);
      if (dv0.getUint32(0, true) !== 4) errors.push('not AdvanceNonceAccount');
      o += 4;
    }

    // transfer instruction
    const programIdx = message[o++];
    if (!isSystem(programIdx)) errors.push('program is not SystemProgram');
    const nIxAccounts = readShortvec(message, o);
    o = nIxAccounts.offset;
    if (nIxAccounts.value !== 2) errors.push('instruction must reference 2 accounts');
    const fromIdx = message[o++];
    const toIdx = message[o++];
    const dataLen = readShortvec(message, o);
    o = dataLen.offset;
    if (dataLen.value !== 12) errors.push('instruction data is not a transfer');
    const dv = new DataView(message.buffer, message.byteOffset + o);
    const instruction = dv.getUint32(0, true);
    const lamports = dv.getBigUint64(4, true);
    o += 12;
    if (o !== message.length) errors.push('trailing bytes in message');
    if (instruction !== 2) errors.push('not SystemInstruction::Transfer');
    if (!bytesEqual(accounts[fromIdx] ?? new Uint8Array(), ownPubkey))
      errors.push('transfer source is not the wallet');
    if (!bytesEqual(accounts[0] ?? new Uint8Array(), ownPubkey))
      errors.push('signer is not the wallet');
    if (!bytesEqual(accounts[toIdx] ?? new Uint8Array(), destination))
      errors.push('recipient mismatch');
    if (lamports !== amount) errors.push(`lamports ${lamports} != declared ${amount}`);
  } catch (e) {
    errors.push(`failed to parse message: ${(e as Error).message}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: `Solana${durable ? ' (durable nonce)' : ''}: ${amount} lamports -> ${bytesToHex(destination)}`,
  };
}

function readShortvec(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let o = offset;
  for (;;) {
    const b = bytes[o++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 14) throw new Error('shortvec too large');
  }
  return { value, offset: o };
}

// === Unverified payloads ===

/**
 * For unverified payloads no machine check is possible; produce a decode
 * attempt for human review and force explicit acknowledgement in the UI.
 */
export function describeUnverifiedPayload(message: Uint8Array): string {
  return `UNVERIFIED PAYLOAD (${message.length} bytes): ${bytesToHex(message)} - review the raw bytes against an independent decoder before approving.`;
}

