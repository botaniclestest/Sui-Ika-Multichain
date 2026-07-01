/**
 * Performs a package upgrade via the TS SDK (works when the local sui CLI
 * binary is older than the network protocol).
 *
 * Usage:
 *   sui move build --dump-bytecode-as-base64 > /tmp/opencode/build_dump.json   (in the package dir)
 *   SUI_SECRET_KEY=... pnpm tsx scripts/upgrade-testnet.ts /tmp/opencode/build_dump.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction, UpgradePolicy } from '@mysten/sui/transactions';

const root = resolve(import.meta.dirname, '..');
const dumpPath = process.argv[2];
if (!dumpPath) throw new Error('pass the build dump path');
const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as {
  modules: string[];
  dependencies: string[];
  digest: number[];
};

const deploymentsPath = resolve(root, 'deployments.json');
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8'));
const dep = deployments.testnet;
const upgradeCapId: string = dep.upgradeCapId;
const packageId: string = dep.latestPackageId ?? dep.policyPackageId;

const secret = process.env.SUI_SECRET_KEY;
if (!secret) throw new Error('set SUI_SECRET_KEY');
const parsed = decodeSuiPrivateKey(secret);
const keypair =
  parsed.scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    : Ed25519Keypair.fromSecretKey(parsed.secretKey);

// Sui fullnode over gRPC (JSON-RPC is deprecated).
const sui = new SuiGrpcClient({
  baseUrl: 'https://fullnode.testnet.sui.io:443',
  network: 'testnet',
});

async function main() {
  const tx = new Transaction();
  tx.setSender(keypair.getPublicKey().toSuiAddress());

  const ticket = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [
      tx.object(upgradeCapId),
      tx.pure.u8(UpgradePolicy.COMPATIBLE),
      tx.pure.vector('u8', dump.digest),
    ],
  });
  const receipt = tx.upgrade({
    modules: dump.modules,
    dependencies: dump.dependencies,
    package: packageId,
    ticket,
  });
  tx.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [tx.object(upgradeCapId), receipt],
  });

  const result = await sui.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true },
  });
  const txn = result.Transaction ?? result.FailedTransaction;
  if (!txn || !txn.status.success) {
    throw new Error(`upgrade failed: ${JSON.stringify(txn?.status.error ?? 'unknown')}`);
  }
  await sui.waitForTransaction({ digest: txn.digest });

  const published = txn.effects?.changedObjects.find((c) => c.outputState === 'PackageWrite');
  if (!published) throw new Error('no published package in upgrade result');

  deployments.testnet.latestPackageId = published.objectId;
  deployments.testnet.lastUpgradeDigest = txn.digest;
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));

  console.log(`upgraded. latest package: ${published.objectId}`);
  console.log(`original (types/events): ${dep.policyPackageId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
