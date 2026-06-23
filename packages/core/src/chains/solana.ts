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
  Keypair,
  NONCE_ACCOUNT_LENGTH,
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

export interface DurableNonce {
  noncePubkey: string;
  nonceValue: string;
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

/**
 * Plain recent-blockhash transfer. WARNING: expires ~60-90s after creation,
 * which is far less than any realistic multisig voting window. Use
 * `buildSolDurableTransfer` for policy-gated spends; this remains only for
 * single-signer fast-path setups and tests.
 */
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

/**
 * Durable-nonce transfer: valid until the nonce is consumed, however long
 * voting takes. The nonce authority must be the wallet itself so only the
 * policy-gated Ika signature can consume it (the on-chain verifier
 * enforces this).
 */
export function buildSolDurableTransfer(params: {
  fromPubkey: Uint8Array;
  to: string;
  lamports: bigint;
  nonce: DurableNonce;
}): SolSpendPlan {
  const from = new PublicKey(params.fromPubkey);
  const tx = new SolTransaction({
    feePayer: from,
    recentBlockhash: params.nonce.nonceValue,
  });
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey: new PublicKey(params.nonce.noncePubkey),
      authorizedPubkey: from,
    }),
  );
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

/**
 * Whoever pays the nonce-account rent and signs its creation. Satisfied by:
 *  - a wallet-adapter provider (Phantom/Solflare `window.solana`),
 *  - a local Keypair via `payerFromKeypair` (e.g. a dust-only "gas tank").
 * The payer has NO authority over the nonce afterwards - the nonce
 * authority is always the policy wallet itself.
 */
export interface SolPayer {
  publicKey: PublicKey;
  signTransaction(tx: SolTransaction): Promise<SolTransaction>;
}

export class SolanaBlockhashExpiredError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SolanaBlockhashExpiredError';
  }
}

export function isSolanaBlockhashExpiredError(error: unknown): boolean {
  if (error instanceof SolanaBlockhashExpiredError) return true;
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return /blockhash not found|block height exceeded|signature .* has expired|TransactionExpiredBlockheightExceededError/i.test(
    `${name} ${message}`,
  );
}

export function payerFromKeypair(keypair: Keypair): SolPayer {
  return {
    publicKey: keypair.publicKey,
    async signTransaction(tx: SolTransaction) {
      tx.partialSign(keypair);
      return tx;
    },
  };
}

/** Rent + fee the payer needs to create one nonce account, in lamports. */
export async function nonceCreationCostLamports(rpcUrl: string): Promise<number> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  return rent + 10_000; // + fee margin
}

/**
 * Creates and initializes a fresh durable-nonce account whose AUTHORITY is
 * the wallet's Solana address. Works identically on devnet and mainnet:
 * the rent (~0.0015 SOL, recoverable by the wallet authority) is paid by
 * the supplied payer - no faucets involved. One nonce account per spend
 * request keeps concurrent requests conflict-free.
 */
export async function createDurableNonceAccount(
  rpcUrl: string,
  authority: Uint8Array,
  payer: SolPayer,
): Promise<DurableNonce> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const nonceAccount = Keypair.generate();

  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const balance = await connection.getBalance(payer.publicKey, 'confirmed');
  const needed = rent + 10_000;
  if (balance < needed) {
    throw new Error(
      `nonce rent payer ${payer.publicKey.toBase58()} holds ${(balance / 1e9).toFixed(6)} SOL ` +
        `but needs ${(needed / 1e9).toFixed(6)} SOL. Send it SOL from any wallet and retry.`,
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
  const tx = new SolTransaction({
    feePayer: payer.publicKey,
    blockhash,
    lastValidBlockHeight,
  });
  tx.add(
    ...SystemProgram.createNonceAccount({
      fromPubkey: payer.publicKey,
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: new PublicKey(authority),
      lamports: rent,
    }).instructions,
  );
  tx.partialSign(nonceAccount);
  const signed = await payer.signTransaction(tx);

  const currentBlockHeight = await connection.getBlockHeight('processed');
  if (currentBlockHeight > lastValidBlockHeight) {
    throw new SolanaBlockhashExpiredError(
      'Solana nonce-rent transaction expired while waiting for wallet approval. Retry and approve the browser-wallet signature promptly; no nonce account was created.',
    );
  }

  let sig: string | null = null;
  try {
    sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
  } catch (error) {
    if (isSolanaBlockhashExpiredError(error)) {
      throw new SolanaBlockhashExpiredError(
        sig
          ? `Solana nonce-rent transaction ${sig} expired before confirmation. Retry and approve the browser-wallet signature promptly. No spend request was created.`
          : 'Solana nonce-rent transaction expired before broadcast. Retry and approve the browser-wallet signature promptly; no nonce rent was spent.',
        error,
      );
    }
    throw error;
  }

  const nonceInfo = await connection.getNonce(nonceAccount.publicKey, 'confirmed');
  if (!nonceInfo) throw new Error('nonce account not found after creation');
  return {
    noncePubkey: nonceAccount.publicKey.toBase58(),
    nonceValue: nonceInfo.nonce,
  };
}

/** Current nonce value of an existing nonce account. */
export async function fetchNonceValue(rpcUrl: string, noncePubkey: string): Promise<string> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const info = await connection.getNonce(new PublicKey(noncePubkey), 'confirmed');
  if (!info) throw new Error(`nonce account ${noncePubkey} not found`);
  return info.nonce;
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

export async function fetchSolBalance(rpcUrl: string, address: string): Promise<bigint> {
  const connection = new Connection(rpcUrl, 'confirmed');
  return BigInt(await connection.getBalance(new PublicKey(address), 'confirmed'));
}

export function solSignatureBase58(signature64: Uint8Array): string {
  return base58.encode(signature64);
}

export function debugSolMessage(message: Uint8Array): string {
  return bytesToHex(message);
}
