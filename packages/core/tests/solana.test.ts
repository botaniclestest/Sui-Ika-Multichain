import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Transaction as SolTransaction } from '@solana/web3.js';
import {
  assembleSolTransaction,
  buildSolTransfer,
  deriveSolanaAddress,
  solanaAddressBytes,
} from '../src/chains/solana.js';
import { checkSolIntent } from '../src/verify/intent.js';
import { hexToBytes } from '../src/codec.js';

const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const PUB = ed25519.getPublicKey(SECRET);
const DEST = 'GitYucwpNcg6Dx1Y15UQ9TQn8LZMX1uuqQNn8rXxEWNC';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

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
  });
});
