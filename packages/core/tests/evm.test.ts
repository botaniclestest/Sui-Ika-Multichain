import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Transaction as EthersTransaction } from 'ethers';
import {
  assembleEvmTransaction,
  buildErc20Transfer,
  buildEvmTransfer,
  deriveEvmAddress,
  evmAddressBytes,
} from '../src/chains/evm.js';
import { checkEvmIntent } from '../src/verify/intent.js';
import { bytesToHex, hexToBytes } from '../src/codec.js';

const PRIV = hexToBytes('3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b');
const PUB = secp256k1.getPublicKey(PRIV, false);
const ADDR = deriveEvmAddress(PUB);
const DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('evm adapter', () => {
  it('derives the same address ethers computes', async () => {
    const { computeAddress } = await import('ethers');
    expect(ADDR).toBe(computeAddress(bytesToHex(PUB, true)));
  });

  it('builds an EIP-1559 native transfer ethers can parse back', () => {
    const plan = buildEvmTransfer({
      chainId: 8453n,
      nonce: 7,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 21_000n,
      to: DEST,
      value: 123_456_789n,
    });
    expect(plan.message[0]).toBe(0x02);
    const parsed = EthersTransaction.from(bytesToHex(plan.message, true));
    expect(parsed.chainId).toBe(8453n);
    expect(parsed.to).toBe(DEST);
    expect(parsed.value).toBe(123_456_789n);
  });

  it('attaches an Ika-style 64-byte signature and recovers correctly', () => {
    const plan = buildEvmTransfer({
      chainId: 1n,
      nonce: 0,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 21_000n,
      to: DEST,
      value: 1n,
    });
    const digest = keccak_256(plan.message);
    const sig = secp256k1.sign(digest, PRIV, { prehash: false });
    const signedHex = assembleEvmTransaction(plan.assembly, sig, ADDR);
    const parsed = EthersTransaction.from(signedHex);
    expect(parsed.from).toBe(ADDR);
    expect(parsed.to).toBe(DEST);
  });

  it('rejects a signature from a different key', () => {
    const plan = buildEvmTransfer({
      chainId: 1n,
      nonce: 0,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 21_000n,
      to: DEST,
      value: 1n,
    });
    const otherKey = hexToBytes('11'.repeat(32));
    const digest = keccak_256(plan.message);
    const sig = secp256k1.sign(digest, otherKey, { prehash: false });
    expect(() => assembleEvmTransaction(plan.assembly, sig, ADDR)).toThrow(
      /does not recover/,
    );
  });

  it('intent check approves matching native transfers and rejects tampering', () => {
    const plan = buildEvmTransfer({
      chainId: 8453n,
      nonce: 3,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 21_000n,
      to: DEST,
      value: 5_000n,
    });
    const ok = checkEvmIntent({
      message: plan.message,
      chainId: 8453n,
      asset: new Uint8Array(),
      destination: evmAddressBytes(DEST),
      amount: 5_000n,
      feeLimit: 2_000_000_000n * 21_000n,
    });
    expect(ok.ok, ok.errors.join('; ')).toBe(true);

    const wrongChain = checkEvmIntent({
      message: plan.message,
      chainId: 1n,
      asset: new Uint8Array(),
      destination: evmAddressBytes(DEST),
      amount: 5_000n,
      feeLimit: 2_000_000_000n * 21_000n,
    });
    expect(wrongChain.ok).toBe(false);

    const wrongAmount = checkEvmIntent({
      message: plan.message,
      chainId: 8453n,
      asset: new Uint8Array(),
      destination: evmAddressBytes(DEST),
      amount: 5_001n,
      feeLimit: 2_000_000_000n * 21_000n,
    });
    expect(wrongAmount.ok).toBe(false);
  });

  it('intent check validates ERC-20 transfers', () => {
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const plan = buildErc20Transfer({
      chainId: 1n,
      nonce: 1,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 65_000n,
      token,
      to: DEST,
      amount: 1_000_000n,
    });
    const ok = checkEvmIntent({
      message: plan.message,
      chainId: 1n,
      asset: evmAddressBytes(token),
      destination: evmAddressBytes(DEST),
      amount: 1_000_000n,
      feeLimit: 30_000_000_000n * 65_000n,
    });
    expect(ok.ok, ok.errors.join('; ')).toBe(true);

    // declared recipient differs from calldata recipient
    const bad = checkEvmIntent({
      message: plan.message,
      chainId: 1n,
      asset: evmAddressBytes(token),
      destination: evmAddressBytes('0x000000000000000000000000000000000000dEaD'),
      amount: 1_000_000n,
      feeLimit: 30_000_000_000n * 65_000n,
    });
    expect(bad.ok).toBe(false);
  });
});
