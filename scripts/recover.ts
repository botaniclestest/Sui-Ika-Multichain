/**
 * Recovery drill: prove the "frontend can disappear" guarantee.
 *
 * Starting from ONLY a Sui secret key and deployments.json, rebuild the
 * complete wallet view: wallets, signers, policies, per-chain addresses
 * (re-derived from Ika dWallet public outputs and cross-checked against the
 * on-chain address book), balances of fee reserves, and pending work.
 *
 * Usage:
 *   SUI_SECRET_KEY=suiprivkey1... pnpm tsx scripts/recover.ts [testnet|mainnet]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import {
  IkaService,
  discoverWallets,
  recoverWallet,
} from '@mythos/wallet-core';

const network = (process.argv[2] ?? 'testnet') as 'testnet' | 'mainnet';
const root = resolve(import.meta.dirname, '..');
const deployments = JSON.parse(readFileSync(resolve(root, 'deployments.json'), 'utf8'));
const dep = deployments[network];
if (!dep) throw new Error(`no ${network} deployment in deployments.json`);

const secret = process.env.SUI_SECRET_KEY;
if (!secret) throw new Error('set SUI_SECRET_KEY');
const parsed = decodeSuiPrivateKey(secret);
const keypair =
  parsed.scheme === 'Secp256k1'
    ? Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    : Ed25519Keypair.fromSecretKey(parsed.secretKey);
const me = keypair.getPublicKey().toSuiAddress();

// Sui fullnode over gRPC (JSON-RPC is deprecated).
const rpc =
  network === 'mainnet'
    ? 'https://fullnode.mainnet.sui.io:443'
    : 'https://fullnode.testnet.sui.io:443';
const sui = new SuiGrpcClient({ baseUrl: rpc, network });
const ika = new IkaService(sui, network);

async function main() {
  console.log(`recovering as ${me} on ${network}\n`);
  const wallets = await discoverWallets(
    sui,
    dep.policyPackageId,
    dep.registryId,
    me,
    `https://graphql.${network}.sui.io/graphql`,
  );
  if (wallets.length === 0) {
    console.log('no wallets found for this signer.');
    return;
  }

  for (const walletId of wallets) {
    console.log(`=== wallet ${walletId} ===`);
    const r = await recoverWallet(sui, ika, walletId, network === 'mainnet' ? 'mainnet' : 'testnet');
    console.log(`signers (${r.state.threshold}-of-${r.state.signers.length}, admin ${r.state.adminThreshold}):`);
    for (const s of r.state.signers) console.log(`  ${s}${s === me ? '  <- you' : ''}`);
    console.log(`paused: ${r.state.paused}  setup complete: ${r.state.setupComplete}`);
    console.log(`fee reserves: ${r.state.ikaBalance} IKA-units, ${r.state.suiBalance} MIST`);
    console.log('addresses:');
    for (const a of r.addresses) {
      console.log(`  ${a.chainKey.padEnd(18)} ${a.address}  verified=${a.verified}`);
    }
    console.log('policies:');
    for (const [key, c] of r.state.chains) {
      console.log(
        `  ${key.padEnd(18)} enabled=${c.enabled} perTx=${c.perTxLimit} window=${c.windowLimit}/${c.windowMs}ms ` +
          `fast=${c.fastPathLimit} fee<=${c.feeLimit} allowlist=${c.allowlistEnabled} unverified=${c.allowUnverified}`,
      );
    }
    console.log(`pending spend requests: ${r.pendingRequests.length}`);
    for (const req of r.pendingRequests) {
      console.log(
        `  #${req.id} ${req.chainKey} amount=${req.amount} approvals=${req.approvals.length} ` +
          `rejections=${req.rejections.length} verified=${req.verifiedIntent}`,
      );
    }
    console.log(`pending proposals: ${r.pendingProposals.length}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
