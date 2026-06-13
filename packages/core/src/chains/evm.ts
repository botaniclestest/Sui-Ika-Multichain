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
