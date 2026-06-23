/**
 * Publishes the policy_wallet Move package and records the deployment.
 *
 * Usage:
 *   pnpm tsx scripts/publish.ts [testnet|mainnet]
 *
 * Requires the `sui` CLI configured with an active address holding gas on
 * the target network. Writes/updates `deployments.json` at the repo root -
 * commit that file: together with the package id it is everything a rebuilt
 * frontend needs to find every wallet again.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const network = (process.argv[2] ?? 'testnet') as 'testnet' | 'mainnet';
const root = resolve(import.meta.dirname, '..');
const contractDir = resolve(root, 'contracts/policy_wallet');
const deploymentsPath = resolve(root, 'deployments.json');

function main() {
  console.log(`Publishing policy_wallet to ${network}...`);

  const moveToml = readFileSync(resolve(contractDir, 'Move.toml'), 'utf8');
  if (network === 'mainnet' && moveToml.includes('vendor/testnet')) {
    console.error(
      'Move.toml still points at vendor/testnet Ika packages. ' +
        'Switch the dependency paths to vendor/mainnet before a mainnet publish.',
    );
    process.exit(1);
  }

  const envOutput = execSync('sui client active-env', { encoding: 'utf8' }).trim();
  console.log(`sui CLI active env: ${envOutput}`);
  if (!envOutput.includes(network)) {
    console.error(`Active sui env "${envOutput}" does not match target "${network}". Aborting.`);
    process.exit(1);
  }

  const raw = execSync(
    `sui client publish --gas-budget 500000000 --json "${contractDir}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(raw);

  const status = result?.effects?.V2?.status ?? result?.effects?.status?.status ?? result?.effects?.status;
  if (status !== 'Success' && status !== 'success' && status?.status !== 'success') {
    console.error('Publish output did not report success directly; checking objectChanges...');
  }

  const changes = result.objectChanges ?? result.changed_objects ?? [];
  const published = changes.find(
    (c: { type?: string; objectType?: string }) => c.type === 'published' || c.objectType === 'package',
  );
  const registry = changes.find(
    (c: { type?: string; objectType?: string }) =>
      (c.type === undefined || c.type === 'created') && c.objectType?.endsWith('::registry::Registry'),
  );
  const upgradeCap = changes.find(
    (c: { type?: string; objectType?: string }) =>
      (c.type === undefined || c.type === 'created') && c.objectType?.endsWith('::package::UpgradeCap'),
  );
  if (!published || !registry) {
    console.error('Could not locate package/registry in publish output.');
    process.exit(1);
  }

  const packageId = published.packageId ?? published.objectId;
  if (!packageId) {
    console.error('Could not locate published package id in publish output.');
    process.exit(1);
  }

  const deployments = existsSync(deploymentsPath)
    ? JSON.parse(readFileSync(deploymentsPath, 'utf8'))
    : {};
  deployments[network] = {
    policyPackageId: packageId,
    registryId: registry.objectId,
    ...(upgradeCap ? { upgradeCapId: upgradeCap.objectId } : {}),
    publishedAt: new Date().toISOString(),
    publishDigest: result.digest,
  };
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));

  console.log(`package:  ${packageId}`);
  console.log(`registry: ${registry.objectId}`);
  if (upgradeCap) console.log(`upgradeCap: ${upgradeCap.objectId}`);
  console.log(`deployments.json updated.`);
}

main();
