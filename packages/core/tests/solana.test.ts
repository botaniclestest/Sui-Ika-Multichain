import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Transaction as SolTransaction } from '@solana/web3.js';
import {
  assembleSolTransaction,
  buildSolDurableTransfer,
  buildSolDurableSplTransfer,
  buildSolTransfer,
  deriveSolanaAddress,
  isSolanaBlockhashExpiredError,
  memoInstruction,
  MEMO_PROGRAM_ID,
  SolanaBlockhashExpiredError,
  solanaAddressBytes,
} from '../src/chains/solana.js';
import { checkSolIntent } from '../src/verify/intent.js';
import { concatBytes, hexToBytes } from '../src/codec.js';

const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const PUB = ed25519.getPublicKey(SECRET);
const DEST = 'GitYucwpNcg6Dx1Y15UQ9TQn8LZMX1uuqQNn8rXxEWNC';
const SPL_MINT = 'So11111111111111111111111111111111111111112';
const SPL_SOURCE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const SYSVAR_RECENT_BLOCKHASHES = hexToBytes(
  '06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000',
);

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

describe('solana adapter', () => {
  it('derives the base58 address from the ed25519 pubkey', () => {
    const addr = deriveSolanaAddress(PUB);
    expect(solanaAddressBytes(addr)).toEqual(PUB);
  });

  it('builds a legacy transfer message web3.js can verify end-to-end', () => {
    const plan = buildSolTransfer({
      fromPubkey: PUB,
      to: DEST,
      lamports: 1_000_000n,
      recentBlockhash: BLOCKHASH,
    });
    const signature = ed25519.sign(plan.message, SECRET);
    const wire = assembleSolTransaction(plan.assembly, signature);
    const parsed = SolTransaction.from(Buffer.from(wire));
    expect(parsed.verifySignatures()).toBe(true);
  });

  it('intent check approves matching transfers and rejects tampering', () => {
    const plan = buildSolTransfer({
      fromPubkey: PUB,
      to: DEST,
      lamports: 42_000n,
      recentBlockhash: BLOCKHASH,
    });
    const ok = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 42_000n,
    });
    expect(ok.ok, ok.errors.join('; ')).toBe(true);

    const wrongAmount = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 42_001n,
    });
    expect(wrongAmount.ok).toBe(false);

    const wrongDest = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      destination: new Uint8Array(32).fill(9),
      amount: 42_000n,
    });
    expect(wrongDest.ok).toBe(false);

    const wrongOwner = checkSolIntent({
      message: plan.message,
      ownPubkey: new Uint8Array(32).fill(1),
      destination: solanaAddressBytes(DEST),
      amount: 42_000n,
    });
    expect(wrongOwner.ok).toBe(false);

    const duplicateSource = concatBytes(
      new Uint8Array([1, 0, 1, 4]),
      PUB,
      solanaAddressBytes(DEST),
      PUB,
      new Uint8Array(32),
      new Uint8Array(32).fill(0xee),
      new Uint8Array([1, 3, 2, 2, 1, 12]),
      u32le(2),
      u64le(42_000n),
    );
    const duplicateSourceCheck = checkSolIntent({
      message: duplicateSource,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 42_000n,
    });
    expect(duplicateSourceCheck.ok).toBe(false);
    expect(duplicateSourceCheck.errors).toContain('transfer source is not the wallet signer');
  });
});

describe('solana durable nonce', () => {
  const NONCE = { noncePubkey: '7Y9dRMi9aGYgWnRNw4Sv5capNZWNXgrTPiYnGPzMYTQS', nonceValue: BLOCKHASH };

  it('recognizes blockhash expiry errors from web3.js', () => {
    expect(
      isSolanaBlockhashExpiredError(
        new Error('Signature 4VS2VGa3vMEnQpRZDRP3b5tATXTxEZ4pkrs9Y9MSFQMmvs has expired: block height exceeded.'),
      ),
    ).toBe(true);
    expect(
      isSolanaBlockhashExpiredError(
        new SolanaBlockhashExpiredError('Solana nonce-rent transaction expired before confirmation.'),
      ),
    ).toBe(true);
    expect(isSolanaBlockhashExpiredError(new Error('insufficient funds for rent'))).toBe(false);
  });

  it('builds a durable-nonce transfer web3.js can verify end-to-end', () => {
    const plan = buildSolDurableTransfer({
      fromPubkey: PUB,
      to: DEST,
      lamports: 50_000_000n,
      nonce: NONCE,
    });
    const signature = ed25519.sign(plan.message, SECRET);
    const wire = assembleSolTransaction(plan.assembly, signature);
    const parsed = SolTransaction.from(Buffer.from(wire));
    expect(parsed.verifySignatures()).toBe(true);
    expect(parsed.instructions.length).toBe(2);
  });

  it('intent check accepts durable form and rejects tampering', () => {
    const plan = buildSolDurableTransfer({
      fromPubkey: PUB,
      to: DEST,
      lamports: 50_000_000n,
      nonce: NONCE,
    });
    const ok = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 50_000_000n,
    });
    expect(ok.ok, ok.errors.join('; ')).toBe(true);
    expect(ok.summary).toContain('durable nonce');

    const wrongAmount = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 50_000_001n,
    });
    expect(wrongAmount.ok).toBe(false);

    // a durable transfer whose nonce authority is NOT the wallet must fail
    const foreign = buildSolDurableTransfer({
      fromPubkey: PUB,
      to: DEST,
      lamports: 50_000_000n,
      nonce: NONCE,
    });
    // re-author the message with a different authority by rebuilding from a
    // foreign key as authority: simplest is checking against a different own key
    const wrongOwner = checkSolIntent({
      message: foreign.message,
      ownPubkey: new Uint8Array(32).fill(1),
      destination: solanaAddressBytes(DEST),
      amount: 50_000_000n,
    });
    expect(wrongOwner.ok).toBe(false);

    const duplicateAuthority = concatBytes(
      new Uint8Array([1, 0, 2, 6]),
      PUB,
      solanaAddressBytes(DEST),
      PUB,
      new Uint8Array(32).fill(0xcd),
      SYSVAR_RECENT_BLOCKHASHES,
      new Uint8Array(32),
      new Uint8Array(32).fill(0xee),
      new Uint8Array([2, 5, 3, 3, 4, 2, 4]),
      u32le(4),
      new Uint8Array([5, 2, 0, 1, 12]),
      u32le(2),
      u64le(50_000_000n),
    );
    const duplicateAuthorityCheck = checkSolIntent({
      message: duplicateAuthority,
      ownPubkey: PUB,
      destination: solanaAddressBytes(DEST),
      amount: 50_000_000n,
    });
    expect(duplicateAuthorityCheck.ok).toBe(false);
    expect(duplicateAuthorityCheck.errors).toContain('nonce authority is not the wallet signer');
  });

  it('builds and verifies a durable SPL token transferChecked message', () => {
    const plan = buildSolDurableSplTransfer({
      fromPubkey: PUB,
      sourceTokenAccount: SPL_SOURCE,
      mint: SPL_MINT,
      destinationOwner: DEST,
      amount: 1_500_000n,
      decimals: 6,
      nonce: NONCE,
    });
    const signature = ed25519.sign(plan.message, SECRET);
    const wire = assembleSolTransaction(plan.assembly, signature);
    const parsed = SolTransaction.from(Buffer.from(wire));
    expect(parsed.verifySignatures()).toBe(true);
    expect(parsed.instructions.length).toBe(3);

    const ok = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      asset: solanaAddressBytes(SPL_MINT),
      destination: solanaAddressBytes(DEST),
      amount: 1_500_000n,
    });
    expect(ok.ok, ok.errors.join('; ')).toBe(true);
    expect(ok.summary).toContain('Solana SPL');

    const wrongMint = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      asset: new Uint8Array(32).fill(9),
      destination: solanaAddressBytes(DEST),
      amount: 1_500_000n,
    });
    expect(wrongMint.ok).toBe(false);

    const wrongAmount = checkSolIntent({
      message: plan.message,
      ownPubkey: PUB,
      asset: solanaAddressBytes(SPL_MINT),
      destination: solanaAddressBytes(DEST),
      amount: 1_500_001n,
    });
    expect(wrongAmount.ok).toBe(false);
  });

  it('pins the SPL Memo v2 program id and builds a no-signer memo', () => {
    // One wrong character here made Phantom's preflight simulation fail
    // with ProgramAccountNotFound ("Unexpected error"); the id is verified
    // live against devnet AND mainnet. Do not edit without re-verifying.
    expect(MEMO_PROGRAM_ID.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const ix = memoInstruction('hello');
    expect(ix.keys.length).toBe(0);
    expect(new TextDecoder().decode(Uint8Array.from(ix.data))).toBe('hello');
  });
});
