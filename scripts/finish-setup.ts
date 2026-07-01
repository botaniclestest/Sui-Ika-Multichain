/**
 * Finishes setup for a wallet whose creation was interrupted before
 * `finalize_setup` (e.g. the wizard failed partway). Creator-only.
 *
 * Usage:
 *   SUI_SECRET_KEY=... WALLET_ID=0x... pnpm tsx scripts/finish-setup.ts \
 *     [chains: comma list, default btc:testnet,eip155:11155111,solana:devnet,sui:vault]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import type { Transaction } from '@mysten/sui/transactions';
import {
  ChainKind,
  Curve,
  IkaCurve,
  IkaService,
  buildAddDwalletTx,
  buildAddPresignTx,
  buildConfigureChainTx,
  buildFinalizeSetupTx,
  buildRecordAddressTx,
  chainDescriptor,
  deriveBtcAddress,
  deriveEvmAddress,
  deriveSolanaAddress,
  evmAddressBytes,
  getWalletState,
  p2wpkhScript,
  utf8,
  type PolicyIds,
} from '@mythos/wallet-core';

const root = resolve(import.meta.dirname, '..');
const deployments = JSON.parse(readFileSync(resolve(root, 'deployments.json'), 'utf8'));
const dep = deployments.testnet;

const walletId = process.env.WALLET_ID;
if (!walletId) throw new Error('set WALLET_ID');
const secret = process.env.SUI_SECRET_KEY;
if (!secret) throw new Error('set SUI_SECRET_KEY');

const chainKeys = (process.argv[2] ?? 'btc:testnet,eip155:11155111,solana:devnet,sui:vault')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const parsed = decodeSuiPrivateKey(secret);
const keypair =
  parsed.scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    : Ed25519Keypair.fromSecretKey(parsed.secretKey);
const me = keypair.getPublicKey().toSuiAddress();

// Sui fullnode over gRPC (JSON-RPC is deprecated).
const sui = new SuiGrpcClient({
  baseUrl: 'https://fullnode.testnet.sui.io:443',
  network: 'testnet',
});
const ika = new IkaService(sui, 'testnet');

async function exec(tx: Transaction, label: string) {
  tx.setSender(me);
  const result = await sui.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true },
  });
  const txn = result.Transaction ?? result.FailedTransaction;
  if (!txn || !txn.status.success) {
    throw new Error(`${label} failed: ${JSON.stringify(txn?.status.error ?? 'unknown')}`);
  }
  await sui.waitForTransaction({ digest: txn.digest });
  console.log(`ok: ${label} (${txn.digest})`);
  return txn;
}

/** Wizard default limits, scaled to the chain's decimals. */
function defaultLimits(decimals: number) {
  const unit = 10n ** BigInt(decimals);
  return {
    fastPathLimit: 0n, // always require full threshold
    perTxLimit: unit / 10n, // 0.1
    windowLimit: unit / 2n, // 0.5
    windowMs: 86_400_000n, // 24h
    feeLimit: unit / 1000n, // 0.001
  };
}

async function main() {
  await ika.init();
  const ids: PolicyIds = {
    packageId: dep.latestPackageId ?? dep.policyPackageId,
    typesPackageId: dep.policyPackageId,
    registryId: dep.registryId,
    coordinatorId: ika.coordinatorObjectId,
    ikaCoinType: ika.ikaCoinType,
  };

  let state = await getWalletState(sui, walletId!);
  if (state.setupComplete) {
    console.log('setup already complete; nothing to do.');
    return;
  }
  if (state.creator !== me) throw new Error(`setup is creator-only; creator is ${state.creator}`);

  const wantsSolana = chainKeys.some((k) => k.startsWith('solana:'));

  // 1. ed25519 dWallet if Solana requested and missing
  let solanaAvailable = state.dwallets.has(IkaCurve.Ed25519);
  if (wantsSolana && !solanaAvailable) {
    try {
      console.log('creating ed25519 dWallet...');
      const dkg = await ika.prepareSharedDkg(Curve.ED25519, me);
      await exec(
        buildAddDwalletTx(ids, walletId!, {
          curve: IkaCurve.Ed25519,
          centralizedPublicKeyShareAndProof: dkg.centralizedPublicKeyShareAndProof,
          userPublicOutput: dkg.userPublicOutput,
          publicUserSecretKeyShare: dkg.publicUserSecretKeyShare,
          sessionIdentifier: dkg.sessionIdentifier,
        }),
        'add ed25519 dwallet',
      );
      solanaAvailable = true;
    } catch (e) {
      console.log(`WARNING: ed25519 dWallet failed: ${(e as Error).message}`);
      console.log('continuing without Solana.');
    }
  }

  // 2. wait for dWallets, derive identities
  state = await getWalletState(sui, walletId!);
  const secpId = state.dwallets.get(IkaCurve.Secp256k1)!;
  console.log('waiting for secp256k1 dWallet Active...');
  const secp = await ika.getActiveDWallet(secpId);
  console.log(`EVM address: ${deriveEvmAddress(secp.publicKey)}`);
  console.log(`BTC address: ${deriveBtcAddress(secp.publicKey, 'testnet')}`);

  let solPubkey: Uint8Array | null = null;
  const edId = state.dwallets.get(IkaCurve.Ed25519);
  if (solanaAvailable && edId) {
    console.log('waiting for ed25519 dWallet Active...');
    const ed = await ika.getActiveDWallet(edId);
    solPubkey = ed.publicKey;
    console.log(`Solana address: ${deriveSolanaAddress(solPubkey)}`);
  }

  // 3. configure chains + record addresses + finalize, one PTB
  let tx: Transaction | undefined;
  for (const chainKey of chainKeys) {
    const desc = chainDescriptor(chainKey);
    if (!desc) throw new Error(`unknown chain ${chainKey}`);
    if (desc.kind === ChainKind.Solana && !solPubkey) {
      console.log(`skipping ${chainKey} (no ed25519 dWallet)`);
      continue;
    }
    if (state.chains.has(chainKey)) {
      console.log(`${chainKey} already configured; skipping`);
      continue;
    }
    const limits = defaultLimits(desc.decimals);
    tx = buildConfigureChainTx(
      ids,
      walletId!,
      {
        chainKey: utf8(chainKey),
        kind: desc.kind,
        evmChainId: desc.evmChainId ?? 0n,
        ...limits,
        allowlistEnabled: false,
        allowUnverified: false,
      },
      tx,
    );
    if (desc.kind === ChainKind.Btc) {
      buildRecordAddressTx(ids, walletId!, utf8(chainKey), p2wpkhScript(secp.publicKey), tx);
    } else if (desc.kind === ChainKind.Evm) {
      buildRecordAddressTx(
        ids,
        walletId!,
        utf8(chainKey),
        evmAddressBytes(deriveEvmAddress(secp.publicKey)),
        tx,
      );
    } else if (desc.kind === ChainKind.Solana && solPubkey) {
      buildRecordAddressTx(ids, walletId!, utf8(chainKey), solPubkey, tx);
    }
  }
  if (!tx) throw new Error('nothing to configure');
  buildFinalizeSetupTx(ids, walletId!, tx);
  await exec(tx, 'configure chains + record addresses + finalize');

  // 4. presigns (paid from wallet reserves)
  await exec(buildAddPresignTx(ids, walletId!, IkaCurve.Secp256k1, 0, 2), '2 secp256k1 presigns');
  if (solPubkey) {
    try {
      await exec(buildAddPresignTx(ids, walletId!, IkaCurve.Ed25519, 0, 1), '1 ed25519 presign');
    } catch (e) {
      console.log(`WARNING: ed25519 presign failed: ${(e as Error).message}`);
    }
  }

  console.log('\nsetup complete. The wallet is fully usable from the dashboard.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
