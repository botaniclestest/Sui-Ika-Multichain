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
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
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

const sui = new SuiJsonRpcClient({
  url: 'https://fullnode.testnet.sui.io:443',
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
    options: { showEffects: true, showObjectChanges: true },
  });
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`upgrade failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await sui.waitForTransaction({ digest: result.digest });

  const published = (result.objectChanges ?? []).find(
    (c) => c.type === 'published',
  ) as { packageId: string } | undefined;
  if (!published) throw new Error('no published change in upgrade result');

  deployments.testnet.latestPackageId = published.packageId;
  deployments.testnet.lastUpgradeDigest = result.digest;
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));

  console.log(`upgraded. latest package: ${published.packageId}`);
  console.log(`original (types/events): ${dep.policyPackageId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
