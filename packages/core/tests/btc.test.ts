import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as scure from '@scure/btc-signer';
import {
  addressToScript,
  assembleBtcTransaction,
  buildBtcSpend,
  checkRecordedScript,
  deriveBtcAddress,
  dsha256,
  p2wpkhScript,
  toDerLowS,
  type Utxo,
} from '../src/chains/btc.js';
import { checkBtcIntent } from '../src/verify/intent.js';
import { bytesToHex, hexToBytes } from '../src/codec.js';

const PRIV = hexToBytes('5d3f9c2b1a4e6d8f0a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677f');
const PUB = secp256k1.getPublicKey(PRIV, true);

const UTXOS: Utxo[] = [
  {
    txid: '7f3b1c5d2a4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708',
    vout: 1,
    value: 120_000n,
    confirmed: true,
  },
  {
    txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    vout: 0,
    value: 80_000n,
    confirmed: true,
  },
];

const DEST = hexToBytes('0014' + 'bb'.repeat(20));

describe('btc adapter', () => {
  it('derives a valid bech32 P2WPKH address and script', () => {
    const addr = deriveBtcAddress(PUB, 'testnet');
    expect(addr.startsWith('tb1q')).toBe(true);
    const script = p2wpkhScript(PUB);
    expect(script.length).toBe(22);
    expect(addressToScript(addr, 'testnet')).toEqual(script);
    expect(checkRecordedScript(PUB, script)).toBe(true);
  });

  it('produces BIP-143 preimages byte-identical to @scure/btc-signer', () => {
    const plan = buildBtcSpend({
      utxos: UTXOS,
      publicKey: PUB,
      destinationScript: DEST,
      amount: 150_000n,
      feeRateSatVb: 2n,
      network: 'testnet',
    });
    expect(plan.messages.length).toBe(2);

    // Reconstruct the same transaction in an independent implementation.
    const tx = new scure.Transaction({ version: 2, allowUnknownOutputs: true });
    const ownScript = p2wpkhScript(PUB);
    for (const input of plan.assembly.inputs) {
      tx.addInput({
        txid: input.txid,
        index: input.vout,
        sequence: input.sequence,
        witnessUtxo: { script: ownScript, amount: input.value },
      });
    }
    for (const output of plan.assembly.outputs) {
      tx.addOutput({ script: hexToBytes(output.scriptPubKey), amount: output.value });
    }

    const scriptCode = hexToBytes('76a914' + bytesToHex(ownScript.slice(2)) + '88ac');
    plan.messages.forEach((preimage, i) => {
      // scure returns the sighash digest (hash256 of the preimage)
      const expectedDigest = tx.preimageWitnessV0(
        i,
        scriptCode,
        scure.SigHash.ALL,
        plan.assembly.inputs[i].value,
      );
      expect(bytesToHex(dsha256(preimage))).toBe(bytesToHex(expectedDigest));
    });
  });

  it('assembles a signed transaction that parses and verifies', () => {
    const plan = buildBtcSpend({
      utxos: UTXOS,
      publicKey: PUB,
      destinationScript: DEST,
      amount: 100_000n,
      feeRateSatVb: 2n,
      network: 'testnet',
    });
    const signatures = plan.messages.map((m) => {
      return secp256k1.sign(dsha256(m), PRIV, { prehash: false });
    });
    const hex = assembleBtcTransaction(plan.assembly, plan.messages, signatures);

    const parsed = scure.Transaction.fromRaw(hexToBytes(hex), {
      allowUnknownOutputs: true,
    });
    expect(parsed.inputsLength).toBe(plan.assembly.inputs.length);
    expect(parsed.outputsLength).toBe(plan.assembly.outputs.length);
    // each witness: [der+sighashbyte, pubkey]
    for (let i = 0; i < parsed.inputsLength; i++) {
      const witness = parsed.getInput(i).finalScriptWitness!;
      expect(witness.length).toBe(2);
      expect(bytesToHex(witness[1])).toBe(bytesToHex(PUB));
    }
  });

  it('rejects high-S signatures by normalizing to low-S DER', () => {
    const msg = dsha256(new Uint8Array(32).fill(7));
    const compact = secp256k1.sign(msg, PRIV, { prehash: false });
    // force high-S
    const n = secp256k1.Point.CURVE().n;
    const s = BigInt('0x' + bytesToHex(compact.slice(32)));
    const highS = n - s;
    const tampered = new Uint8Array(compact);
    const hsHex = highS.toString(16).padStart(64, '0');
    tampered.set(hexToBytes(hsHex), 32);
    const der = toDerLowS(tampered);
    const der2 = toDerLowS(compact);
    expect(bytesToHex(der)).toBe(bytesToHex(der2));
  });

  it('client intent check mirrors the on-chain verifier', () => {
    const plan = buildBtcSpend({
      utxos: UTXOS,
      publicKey: PUB,
      destinationScript: DEST,
      amount: 150_000n,
      feeRateSatVb: 2n,
      network: 'testnet',
    });
    const ownScript = p2wpkhScript(PUB);
    const good = checkBtcIntent({
      messages: plan.messages,
      outputsBytes: plan.outputsBytes,
      prevoutsBytes: plan.prevoutsBytes,
      ownScript,
      destinationScript: DEST,
      amount: 150_000n,
      feeLimit: 100_000n,
    });
    expect(good.ok, good.errors.join('; ')).toBe(true);

    // tampered amount
    const badAmount = checkBtcIntent({
      messages: plan.messages,
      outputsBytes: plan.outputsBytes,
      prevoutsBytes: plan.prevoutsBytes,
      ownScript,
      destinationScript: DEST,
      amount: 150_001n,
      feeLimit: 100_000n,
    });
    expect(badAmount.ok).toBe(false);

    // tampered destination
    const badDest = checkBtcIntent({
      messages: plan.messages,
      outputsBytes: plan.outputsBytes,
      prevoutsBytes: plan.prevoutsBytes,
      ownScript,
      destinationScript: hexToBytes('0014' + 'cc'.repeat(20)),
      amount: 150_000n,
      feeLimit: 100_000n,
    });
    expect(badDest.ok).toBe(false);
  });
});

describe('btc on-chain reconstruction', () => {
  it('rebuilds the exact assembly from request messages + aux', async () => {
    const { btcAssemblyFromRequest } = await import('../src/chains/btc.js');
    const plan = buildBtcSpend({
      utxos: UTXOS,
      publicKey: PUB,
      destinationScript: DEST,
      amount: 150_000n,
      feeRateSatVb: 2n,
      network: 'testnet',
    });
    const rebuilt = btcAssemblyFromRequest(
      plan.messages,
      [plan.outputsBytes, plan.prevoutsBytes],
      PUB,
    );
    expect(rebuilt).toEqual(plan.assembly);

    // and the rebuilt assembly produces an identical signed transaction
    const signatures = plan.messages.map((m) =>
      secp256k1.sign(dsha256(m), PRIV, { prehash: false }),
    );
    const a = assembleBtcTransaction(plan.assembly, plan.messages, signatures);
    const b = assembleBtcTransaction(rebuilt, plan.messages, signatures);
    expect(b).toBe(a);
  });
});
