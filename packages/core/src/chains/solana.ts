/**
 * Solana chain adapter (legacy message, SystemProgram transfer).
 *
 * The message submitted to the policy contract (and signed by Ika with
 * EdDSA/ed25519) is the exact serialized legacy message.
 * `verify_solana.move` parses these bytes on-chain.
 *
 * NOTE: ed25519 dWallet support is gated on the live Ika network's
 * supported-curves configuration. The adapter is complete; check
 * curve availability before configuring a Solana chain on a wallet.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction as SolTransaction,
} from '@solana/web3.js';
import { base58 } from '@scure/base';
import { base64ToBytes, btcVarint, bytesToBase64, bytesToHex, concatBytes } from '../codec.js';

export interface SolAssembly {
  messageBase64: string;
}

export interface SolSpendPlan {
  message: Uint8Array; // serialized legacy message; Ika signs with EdDSA
  assembly: SolAssembly;
}

// === derivation ===

export function deriveSolanaAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return base58.encode(publicKey);
}

export function solanaAddressBytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes();
}

// === transaction building ===

export function buildSolTransfer(params: {
  fromPubkey: Uint8Array;
  to: string;
  lamports: bigint;
  recentBlockhash: string;
}): SolSpendPlan {
  const from = new PublicKey(params.fromPubkey);
  const tx = new SolTransaction({
    feePayer: from,
    recentBlockhash: params.recentBlockhash,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: new PublicKey(params.to),
      lamports: params.lamports,
    }),
  );
  const message = Uint8Array.from(tx.compileMessage().serialize());
  return {
    message,
    assembly: { messageBase64: bytesToBase64(message) },
  };
}

// === signature assembly ===

/** Wire format: shortvec(numSignatures) || signatures || message. */
export function assembleSolTransaction(
  assembly: SolAssembly,
  signature64: Uint8Array,
): Uint8Array {
  if (signature64.length !== 64) throw new Error('expected 64-byte ed25519 signature');
  const message = base64ToBytes(assembly.messageBase64);
  return concatBytes(btcVarint(1), signature64, message);
}

// === RPC I/O ===

export async function fetchRecentBlockhash(rpcUrl: string): Promise<string> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  return blockhash;
}

export async function broadcastSol(rpcUrl: string, signedTx: Uint8Array): Promise<string> {
  const connection = new Connection(rpcUrl, 'confirmed');
  return connection.sendRawTransaction(signedTx, {
    skipPreflight: false,
  });
}

export function solSignatureBase58(signature64: Uint8Array): string {
  return base58.encode(signature64);
}

export function debugSolMessage(message: Uint8Array): string {
  return bytesToHex(message);
}
