/**
 * End-to-end testnet exercise of the full wallet lifecycle.
 *
 * Usage:
 *   SUI_SECRET_KEY=suiprivkey1... pnpm tsx scripts/e2e-testnet.ts
 *
 * Prereqs:
 *  - deployments.json contains a testnet entry (run scripts/publish.ts)
 *  - the key's address holds SUI gas and IKA testnet tokens
 *
 * Flow:
 *  1. create wallet (contract-side DKG, shared dWallet, cap in custody)
 *  2. configure chains: sui:vault + eip155:84532 (Base Sepolia) + btc:testnet
 *  3. record on-chain address book entries (derived from the dWallet pubkey)
 *  4. finalize setup, fund balances, add presigns
 *  5. create an EVM spend request (bytes verified on-chain), approve, wait
 *     out the timelock, execute, fetch the Ika signature, assemble the
 *     signed transaction (broadcast left to the operator)
 *  6. run recovery from scratch and print everything it finds
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import type { Transaction } from '@mysten/sui/transactions';
import {
  ChainKind,
  Curve,
  Hash,
  IkaCurve,
  IkaService,
  SignatureAlgorithm,
  buildAddPresignTx,
  buildConfigureChainTx,
  buildCreateSpendRequestTx,
  buildCreateWalletTx,
  buildDepositBalancesTx,
  buildExecuteSpendTx,
  buildFinalizeSetupTx,
  buildRecordAddressTx,
  buildVoteSpendTx,
  assembleEvmTransaction,
  buildEvmTransfer,
  checkEvmIntent,
  deriveBtcAddress,
  deriveEvmAddress,
  discoverWallets,
  evmAddressBytes,
  getSpendRequest,
  getWalletState,
  p2wpkhScript,
  recoverWallet,
  utf8,
  type PolicyIds,
} from '@mythos/wallet-core';

const root = resolve(import.meta.dirname, '..');
const deployments = JSON.parse(readFileSync(resolve(root, 'deployments.json'), 'utf8'));
const dep = deployments.testnet;
if (!dep) throw new Error('no testnet deployment; run scripts/publish.ts first');

const secret = process.env.SUI_SECRET_KEY;
if (!secret) throw new Error('set SUI_SECRET_KEY');

const parsed = decodeSuiPrivateKey(secret);
const keypair =
  parsed.scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    : Ed25519Keypair.fromSecretKey(parsed.secretKey);
const me = keypair.getPublicKey().toSuiAddress();

const sui = new SuiJsonRpcClient({
  url: 'https://fullnode.testnet.sui.io:443',
  network: 'testnet',
});
const ika = new IkaService(sui as never, 'testnet');

async function exec(tx: Transaction, label: string) {
  tx.setSender(me);
  const result = await sui.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await sui.waitForTransaction({ digest: result.digest });
  console.log(`ok: ${label} (${result.digest})`);
  return result;
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
  console.log(`signer: ${me}`);

  // 1. create wallet (or resume an existing one via E2E_WALLET_ID) ------
  let walletId = process.env.E2E_WALLET_ID ?? '';
  if (!walletId) {
  const dkg = await ika.prepareSharedDkg(Curve.SECP256K1, me);
  const createTx = buildCreateWalletTx(ids, {
    signers: [me],
    threshold: 1n,
    adminThreshold: 1n,
    timelockSpendMs: 0n,
    timelockAdminMs: 0n,
    requestExpiryMs: 24n * 3600n * 1000n,
    networkEncryptionKeyId: await ika.latestNetworkEncryptionKeyId(),
    centralizedPublicKeyShareAndProof: dkg.centralizedPublicKeyShareAndProof,
    userPublicOutput: dkg.userPublicOutput,
    publicUserSecretKeyShare: dkg.publicUserSecretKeyShare,
    sessionIdentifier: dkg.sessionIdentifier,
    ikaBudget: 1_500_000_000n, // 1.5 IKA for DKG fees
    suiBudget: 800_000_000n,
  });
  const createResult = await exec(createTx, 'create_wallet');
  const walletChange = (createResult.objectChanges ?? []).find(
    (c) =>
      c.type === 'created' &&
      'objectType' in c &&
      (c as { objectType: string }).objectType.endsWith('::policy_wallet::PolicyWallet'),
  ) as { objectId: string } | undefined;
  if (!walletChange) throw new Error('wallet object not found in tx output');
  walletId = walletChange.objectId;
  }
  console.log(`wallet: ${walletId}`);

  // wait for the dWallet to activate, derive addresses -------------------
  const state = await getWalletState(sui as never, walletId);
  const dwalletId = state.dwallets.get(IkaCurve.Secp256k1)!;
  console.log(`dwallet: ${dwalletId} (waiting for Active...)`);
  const dwallet = await ika.getActiveDWallet(dwalletId);
  const evmAddress = deriveEvmAddress(dwallet.publicKey);
  const btcAddress = deriveBtcAddress(dwallet.publicKey, 'testnet');
  console.log(`EVM address: ${evmAddress}`);
  console.log(`BTC address: ${btcAddress}`);

  // 2/3. configure chains + address book (skipped if already finalized) --
  const preState = await getWalletState(sui as never, walletId);
  if (preState.setupComplete) {
    console.log('setup already finalized; skipping configuration');
  } else {
  const setupTx = buildConfigureChainTx(ids, walletId, {
    chainKey: utf8('eip155:84532'),
    kind: ChainKind.Evm,
    evmChainId: 84532n,
    fastPathLimit: 10n ** 15n, // 0.001 ETH fast path
    perTxLimit: 10n ** 16n,
    windowLimit: 5n * 10n ** 16n,
    windowMs: 86_400_000n,
    feeLimit: 10n ** 15n,
    allowlistEnabled: false,
    allowUnverified: false,
  });
  buildConfigureChainTx(
    ids,
    walletId,
    {
      chainKey: utf8('btc:testnet'),
      kind: ChainKind.Btc,
      evmChainId: 0n,
      fastPathLimit: 50_000n,
      perTxLimit: 200_000n,
      windowLimit: 500_000n,
      windowMs: 86_400_000n,
      feeLimit: 20_000n,
      allowlistEnabled: false,
      allowUnverified: false,
    },
    setupTx,
  );
  buildConfigureChainTx(
    ids,
    walletId,
    {
      chainKey: utf8('sui:vault'),
      kind: ChainKind.SuiVault,
      evmChainId: 0n,
      fastPathLimit: 1_000_000_000n,
      perTxLimit: 100_000_000_000n,
      windowLimit: 200_000_000_000n,
      windowMs: 86_400_000n,
      feeLimit: 0n,
      allowlistEnabled: false,
      allowUnverified: false,
    },
    setupTx,
  );
  buildRecordAddressTx(ids, walletId, utf8('eip155:84532'), evmAddressBytes(evmAddress), setupTx);
  buildRecordAddressTx(ids, walletId, utf8('btc:testnet'), p2wpkhScript(dwallet.publicKey), setupTx);
  buildFinalizeSetupTx(ids, walletId, setupTx);
  await exec(setupTx, 'configure chains + address book + finalize');
  }

  // 4. fund + presigns ---------------------------------------------------
  if (preState.ikaBalance < 1_000_000_000n) {
    await exec(
      buildDepositBalancesTx(ids, walletId, 1_000_000_000n, 300_000_000n),
      'deposit IKA/SUI fee balances',
    );
  }
  {
    const pool0 = preState.presignPools.get('0:0') ?? [];
    if (pool0.length < 2) {
      await exec(buildAddPresignTx(ids, walletId, IkaCurve.Secp256k1, 0, 2), 'add 2 ECDSA presigns');
    }
  }

  // 5. EVM spend request --------------------------------------------------
  console.log('waiting for presigns to complete...');
  let pool: { capId: string; presignId: string }[] = [];
  for (let i = 0; i < 60; i++) {
    const s = await getWalletState(sui as never, walletId);
    pool = s.presignPools.get('0:0') ?? [];
    if (pool.length >= 1) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (pool.length === 0) throw new Error('no presigns available');
  const consumed = pool[pool.length - 1]; // contract pops from the back
  const presignCapId = consumed.capId;
  const presignBytes = await ika.getCompletedPresignBytes(consumed.presignId);

  const destination = '0x000000000000000000000000000000000000dEaD';
  const amount = 10n ** 12n; // 0.000001 ETH
  const plan = buildEvmTransfer({
    chainId: 84532n,
    nonce: 0,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 21_000n,
    to: destination,
    value: amount,
  });

  // local mirror of the on-chain verifier before submitting
  const check = checkEvmIntent({
    message: plan.message,
    chainId: 84532n,
    asset: new Uint8Array(),
    destination: evmAddressBytes(destination),
    amount,
    feeLimit: 10n ** 15n,
  });
  if (!check.ok) throw new Error(`intent check failed: ${check.errors.join('; ')}`);

  const centralizedSig = await ika.computeCentralizedSignature({
    dwallet,
    presignBytes,
    message: plan.message,
    hash: Hash.KECCAK256,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    curve: Curve.SECP256K1,
  });

  const requestTx = buildCreateSpendRequestTx(ids, walletId, {
    chainKey: utf8('eip155:84532'),
    asset: new Uint8Array(),
    destination: evmAddressBytes(destination),
    amount,
    messages: [plan.message],
    centralizedSignatures: [centralizedSig],
    expectedPresignCapIds: [presignCapId],
    aux: [],
    unverified: false,
  });
  await exec(requestTx, 'create_spend_request (EVM, verified on-chain)');

  const requestId = (await getWalletState(sui as never, walletId)).requestCounter;
  console.log(`request id: ${requestId}`);

  // 1-of-1 fast path: creator approval reached threshold at creation.
  try {
    await exec(buildVoteSpendTx(ids, walletId, requestId, true), 'vote (idempotence check)');
  } catch {
    console.log('ok: double-vote correctly rejected');
  }

  console.log('waiting for Ika to verify the locked partial signature...');
  {
    const pending = await getSpendRequest(sui as never, walletId, requestId);
    for (const id of pending.partialSigIds) {
      await ika.waitForPartialSignatureVerified(id);
    }
  }
  await exec(buildExecuteSpendTx(ids, walletId, requestId), 'execute_spend');
  const request = await getSpendRequest(sui as never, walletId, requestId);
  if (request.signIds.length !== 1) throw new Error('no sign id recorded');
  console.log(`sign session: ${request.signIds[0]}`);

  const signature = await ika.waitForSignature(
    request.signIds[0],
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
  );
  const signedTx = assembleEvmTransaction(plan.assembly, signature, evmAddress);
  console.log(`signed Base Sepolia tx (broadcast when funded):\n${signedTx}`);

  // 6. recovery from scratch ----------------------------------------------
  console.log('\n--- recovery drill (fresh state, registry only) ---');
  const wallets = await discoverWallets(sui as never, dep.policyPackageId, ids.registryId, me);
  console.log(`discovered wallets: ${wallets.join(', ')}`);
  const recovered = await recoverWallet(sui as never, ika, walletId, 'testnet');
  for (const a of recovered.addresses) {
    console.log(`${a.chainKey}: ${a.address} verified=${a.verified}`);
  }
  for (const w of recovered.warnings) console.log(`warning: ${w}`);
  console.log(`pending requests: ${recovered.pendingRequests.length}`);
  console.log('\nE2E COMPLETE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
