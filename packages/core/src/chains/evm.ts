/**
 * EVM chain adapter (EIP-1559, all EVM chains/L2s).
 *
 * The message submitted to the policy contract (and signed by Ika with
 * KECCAK256) is the raw unsigned serialized EIP-1559 transaction
 * (0x02 || rlp([...])). `verify_evm.move` parses these exact bytes on-chain.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  JsonRpcProvider,
  Signature as EthersSignature,
  Transaction as EthersTransaction,
  getAddress,
  recoverAddress,
} from 'ethers';
import { bytesToHex, hexToBytes } from '../codec.js';

export interface EvmAssembly {
  unsignedSerializedHex: string;
}

export interface EvmSpendPlan {
  message: Uint8Array; // unsigned serialized tx; Ika keccaks it
  assembly: EvmAssembly;
}

// === derivation ===

export function deriveEvmAddress(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return getAddress(bytesToHex(hash.slice(12), true));
}

export function evmAddressBytes(address: string): Uint8Array {
  return hexToBytes(getAddress(address));
}

// === transaction building ===

export function buildEvmTransfer(params: {
  chainId: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data?: string;
}): EvmSpendPlan {
  const tx = new EthersTransaction();
  tx.type = 2;
  tx.chainId = params.chainId;
  tx.nonce = params.nonce;
  tx.maxFeePerGas = params.maxFeePerGas;
  tx.maxPriorityFeePerGas = params.maxPriorityFeePerGas;
  tx.gasLimit = params.gasLimit;
  tx.to = getAddress(params.to);
  tx.value = params.value;
  tx.data = params.data ?? '0x';
  const unsigned = tx.unsignedSerialized;
  return {
    message: hexToBytes(unsigned),
    assembly: { unsignedSerializedHex: unsigned },
  };
}

/** ERC-20 transfer(address,uint256) calldata. */
export function erc20TransferData(to: string, amount: bigint): string {
  const dest = getAddress(to).slice(2).toLowerCase().padStart(64, '0');
  const amt = amount.toString(16).padStart(64, '0');
  return `0xa9059cbb${dest}${amt}`;
}

export function buildErc20Transfer(params: {
  chainId: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  token: string;
  to: string;
  amount: bigint;
}): EvmSpendPlan {
  return buildEvmTransfer({
    chainId: params.chainId,
    nonce: params.nonce,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    gasLimit: params.gasLimit,
    to: params.token,
    value: 0n,
    data: erc20TransferData(params.to, params.amount),
  });
}

// === signature assembly ===

/**
 * Attaches the Ika 64-byte r||s signature, determining yParity by recovery
 * and verifying the recovered signer matches the expected address.
 */
export function assembleEvmTransaction(
  assembly: EvmAssembly,
  signature64: Uint8Array,
  expectedAddress: string,
): string {
  if (signature64.length !== 64) throw new Error('expected 64-byte compact signature');
  const tx = EthersTransaction.from(assembly.unsignedSerializedHex);
  const digest = bytesToHex(keccak_256(hexToBytes(assembly.unsignedSerializedHex)), true);

  const r = bytesToHex(signature64.slice(0, 32), true);
  // enforce low-s (EIP-2)
  const n = secp256k1.Point.CURVE().n;
  let sBig = BigInt(bytesToHex(signature64.slice(32, 64), true));
  if (sBig > n / 2n) sBig = n - sBig;
  const s = `0x${sBig.toString(16).padStart(64, '0')}`;

  const expected = getAddress(expectedAddress);
  for (const v of [27, 28]) {
    const candidate = EthersSignature.from({ r, s, v });
    if (recoverAddress(digest, candidate) === expected) {
      tx.signature = candidate;
      return tx.serialized;
    }
  }
  throw new Error('signature does not recover to the wallet address');
}

// === RPC I/O ===

export function evmProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

export async function fetchEvmTxParams(
  rpcUrl: string,
  address: string,
  isContractCall: boolean,
): Promise<{ nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }> {
  const provider = evmProvider(rpcUrl);
  const [nonce, feeData] = await Promise.all([
    provider.getTransactionCount(address, 'pending'),
    provider.getFeeData(),
  ]);
  const maxFeePerGas = (feeData.maxFeePerGas ?? 2_000_000_000n) * 2n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;
  return {
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit: isContractCall ? 100_000n : 21_000n,
  };
}

export async function broadcastEvm(rpcUrl: string, signedTxHex: string): Promise<string> {
  const provider = evmProvider(rpcUrl);
  const response = await provider.broadcastTransaction(signedTxHex);
  return response.hash;
}

export async function fetchEvmNativeBalance(rpcUrl: string, address: string): Promise<bigint> {
  const provider = evmProvider(rpcUrl);
  return provider.getBalance(address);
}

export async function fetchErc20Balance(
  rpcUrl: string,
  token: string,
  owner: string,
): Promise<bigint> {
  const provider = evmProvider(rpcUrl);
  const ownerWord = getAddress(owner).slice(2).toLowerCase().padStart(64, '0');
  const result = await provider.call({
    to: getAddress(token),
    data: `0x70a08231${ownerWord}`,
  });
  return BigInt(result);
}

/**
 * Reads an ERC-20's symbol/decimals straight from the contract, so users
 * can track arbitrary tokens by pasting a contract address (plain JSON-RPC
 * cannot DISCOVER unknown tokens, but it can read a known one).
 * Handles both `string` and legacy `bytes32` symbol encodings.
 */
export async function fetchErc20Metadata(
  rpcUrl: string,
  token: string,
): Promise<{ symbol: string; decimals: number }> {
  const provider = evmProvider(rpcUrl);
  const to = getAddress(token);
  const [decimalsRaw, symbolRaw] = await Promise.all([
    provider.call({ to, data: '0x313ce567' }), // decimals()
    provider.call({ to, data: '0x95d89b41' }).catch(() => '0x'), // symbol()
  ]);
  if (!decimalsRaw || decimalsRaw === '0x') {
    throw new Error('contract did not return decimals(); is this an ERC-20?');
  }
  const decimals = Number(BigInt(decimalsRaw));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`implausible ERC-20 decimals: ${decimals}`);
  }
  return { symbol: decodeEvmStringResult(symbolRaw) || `${to.slice(0, 6)}…`, decimals };
}

/** Decodes an ABI `string` or legacy `bytes32` return value. */
function decodeEvmStringResult(hex: string): string {
  if (!hex || hex === '0x') return '';
  const bytes = hexToBytes(hex);
  let raw: Uint8Array;
  if (bytes.length === 32) {
    raw = bytes; // legacy bytes32 symbol
  } else if (bytes.length >= 64) {
    let len = 0;
    for (const b of bytes.slice(32, 64)) len = len * 256 + b;
    raw = bytes.slice(64, 64 + Math.min(len, 64));
  } else {
    raw = bytes;
  }
  const text = new TextDecoder().decode(raw).replace(/\u0000+$/g, '').trim();
  return /^[\x20-\x7e]{1,32}$/.test(text) ? text : '';
}
