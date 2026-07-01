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
  TransactionInstruction,
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

export interface SolTokenBalance {
  mint: string;
  tokenAccount: string;
  amount: bigint;
  decimals: number;
  uiAmountString: string;
}

export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** SPL Memo v2: lets wallets (Phantom etc.) show a human-readable purpose. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TySNcWxMyWCqXgDLGmfcHr');

/** A no-signer memo instruction; wallets display its text in the approval UI. */
export function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(text) as never,
  });
}

// === derivation ===

export function deriveSolanaAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return base58.encode(publicKey);
}

export function solanaAddressBytes(address: string): Uint8Array {
  return new PublicKey(address).toBytes();
}

export function associatedTokenAddress(mint: string, owner: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata.toBase58();
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

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error('value does not fit u64');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function buildSolDurableSplTransfer(params: {
  fromPubkey: Uint8Array;
  sourceTokenAccount: string;
  mint: string;
  destinationOwner: string;
  amount: bigint;
  decimals: number;
  nonce: DurableNonce;
}): SolSpendPlan & { destinationTokenAccount: string } {
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 255) {
    throw new Error('SPL token decimals must fit u8');
  }
  const from = new PublicKey(params.fromPubkey);
  const mint = new PublicKey(params.mint);
  const destinationOwner = new PublicKey(params.destinationOwner);
  const destinationTokenAccount = new PublicKey(associatedTokenAddress(params.mint, params.destinationOwner));
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
    new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: from, isSigner: true, isWritable: true },
        { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
        { pubkey: destinationOwner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]) as never, // AssociatedTokenAccountInstruction::CreateIdempotent
    }),
  );
  tx.add(
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(params.sourceTokenAccount), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
        { pubkey: from, isSigner: true, isWritable: false },
      ],
      data: concatBytes(new Uint8Array([12]), u64le(params.amount), new Uint8Array([params.decimals])) as never,
    }),
  );
  const message = Uint8Array.from(tx.compileMessage().serialize());
  return {
    message,
    assembly: { messageBase64: bytesToBase64(message) },
    destinationTokenAccount: destinationTokenAccount.toBase58(),
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
  sendTransaction?(tx: SolTransaction): Promise<string>;
}

// Keep this empty unless an endpoint is verified to work from browser CORS.
const MAINNET_SOLANA_RPC_FALLBACKS: string[] = [];

function solanaRpcCandidates(primary: string): string[] {
  const urls = [primary];
  if (primary.includes('mainnet') || primary.includes('publicnode.com')) {
    urls.push(...MAINNET_SOLANA_RPC_FALLBACKS);
  }
  return [...new Set(urls.filter(Boolean))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function getAnyBlockHeight(connections: Connection[]): Promise<number> {
  let lastError: unknown;
  for (const connection of connections) {
    try {
      return await connection.getBlockHeight('processed');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function confirmRecentBlockhashSignature(
  rpcUrl: string,
  signature: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const connections = solanaRpcCandidates(rpcUrl).map((url) => new Connection(url, 'processed'));

  for (;;) {
    for (const connection of connections) {
      try {
        const status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status?.err) {
          throw new Error(`Solana nonce-rent transaction ${signature} failed: ${JSON.stringify(status.err)}`);
        }
        if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized' ||
          status?.confirmations === null
        ) {
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('failed:')) throw error;
      }
    }

    if ((await getAnyBlockHeight(connections)) > lastValidBlockHeight) {
      throw new SolanaBlockhashExpiredError(
        `Solana nonce-rent transaction ${signature} expired before confirmation. Retry once; no spend request was created.`,
      );
    }
    await sleep(1_000);
  }
}

async function sendAndConfirmRawRecentBlockhashTransaction(params: {
  rpcUrl: string;
  rawTransaction: Uint8Array;
  lastValidBlockHeight: number;
}): Promise<string> {
  const connections = solanaRpcCandidates(params.rpcUrl).map((url) => new Connection(url, 'processed'));
  let signature: string | null = null;
  let firstError: unknown;

  const send = async (connection: Connection, skipPreflight: boolean) => {
    try {
      const sent = await connection.sendRawTransaction(params.rawTransaction, {
        skipPreflight,
        preflightCommitment: 'processed',
        maxRetries: skipPreflight ? 0 : 20,
      });
      signature ??= sent;
    } catch (error) {
      firstError ??= error;
    }
  };

  await Promise.all(connections.map((connection) => send(connection, false)));
  if (!signature) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }

  for (;;) {
    for (const connection of connections) {
      try {
        const status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status?.err) {
          throw new Error(`Solana nonce-rent transaction ${signature} failed: ${JSON.stringify(status.err)}`);
        }
        if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized' ||
          status?.confirmations === null
        ) {
          return signature;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('failed:')) throw error;
      }
    }

    if ((await getAnyBlockHeight(connections)) > params.lastValidBlockHeight) {
      throw new SolanaBlockhashExpiredError(
        `Solana nonce-rent transaction ${signature} expired before confirmation. Retry once; no spend request was created.`,
      );
    }

    await Promise.all(connections.map((connection) => send(connection, true)));
    await sleep(1_000);
  }
}

async function fetchNonceAfterConfirmation(rpcUrl: string, noncePubkey: PublicKey) {
  const connections = solanaRpcCandidates(rpcUrl).map((url) => new Connection(url, 'confirmed'));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const connection of connections) {
      try {
        const nonceInfo = await connection.getNonce(noncePubkey, 'confirmed');
        if (nonceInfo) return nonceInfo;
      } catch {
        /* try the next RPC */
      }
    }
    await sleep(500);
  }
  return null;
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
  /**
   * Optional human-readable memo included in the rent transaction so the
   * signing wallet (e.g. Phantom) clearly shows what is being approved.
   */
  memo?: string,
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
  if (memo) tx.add(memoInstruction(memo));
  tx.partialSign(nonceAccount);

  let sig: string | null = null;
  try {
    if (payer.sendTransaction) {
      sig = await payer.sendTransaction(tx);
      await confirmRecentBlockhashSignature(rpcUrl, sig, lastValidBlockHeight);
    } else {
      const signed = await payer.signTransaction(tx);
      const currentBlockHeight = await connection.getBlockHeight('processed');
      if (currentBlockHeight > lastValidBlockHeight) {
        throw new SolanaBlockhashExpiredError(
          'Solana nonce-rent transaction expired while waiting for wallet approval. Retry and approve the browser-wallet signature promptly; no nonce account was created.',
        );
      }
      sig = await sendAndConfirmRawRecentBlockhashTransaction({
        rpcUrl,
        rawTransaction: signed.serialize(),
        lastValidBlockHeight,
      });
    }
  } catch (error) {
    if (isSolanaBlockhashExpiredError(error)) {
      const landedNonce = sig ? await fetchNonceAfterConfirmation(rpcUrl, nonceAccount.publicKey) : null;
      if (landedNonce) {
        return {
          noncePubkey: nonceAccount.publicKey.toBase58(),
          nonceValue: landedNonce.nonce,
        };
      }
      throw new SolanaBlockhashExpiredError(
        sig
          ? `Solana nonce-rent transaction ${sig} expired before confirmation. Retry once. No spend request was created.`
          : 'Solana nonce-rent transaction expired before broadcast. Retry and approve the browser-wallet signature promptly; no nonce rent was spent.',
        error,
      );
    }
    throw error;
  }

  const nonceInfo = await fetchNonceAfterConfirmation(rpcUrl, nonceAccount.publicKey);
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

export async function fetchSolTokenBalances(
  rpcUrl: string,
  owner: string,
): Promise<SolTokenBalance[]> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    programId: SPL_TOKEN_PROGRAM_ID,
  });
  return accounts.value
    .map((entry) => {
      const info = (entry.account.data as { parsed?: { info?: unknown } }).parsed?.info as
        | {
            mint?: string;
            tokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string };
          }
        | undefined;
      if (!info?.mint || !info.tokenAmount?.amount || info.tokenAmount.decimals === undefined) {
        return null;
      }
      return {
        mint: info.mint,
        tokenAccount: entry.pubkey.toBase58(),
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        uiAmountString: info.tokenAmount.uiAmountString ?? info.tokenAmount.amount,
      } satisfies SolTokenBalance;
    })
    .filter((row): row is SolTokenBalance => !!row && row.amount > 0n)
    .sort((a, b) => a.mint.localeCompare(b.mint));
}

export function solSignatureBase58(signature64: Uint8Array): string {
  return base58.encode(signature64);
}

export function debugSolMessage(message: Uint8Array): string {
  return bytesToHex(message);
}
