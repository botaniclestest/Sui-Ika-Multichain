/**
 * PTB builders for every policy_wallet entry point.
 *
 * These are pure transaction constructors: they never hold keys and never
 * talk to the network (except via values you pass in). Sign and execute
 * them with whatever Sui signer you use (browser wallet, keypair, passkey).
 */

import { bcs } from '@mysten/sui/bcs';
import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

const CLOCK = '0x6';
const byteVec = bcs.vector(bcs.u8());
const byteVecVec = bcs.vector(bcs.vector(bcs.u8()));
const idVec = bcs.vector(bcs.Address);
const u128Vec = bcs.vector(bcs.u128());

export interface PolicyIds {
  /** LATEST package id - used as the target of all Move calls. */
  packageId: string;
  /**
   * ORIGINAL (first-published) package id - used for struct types and
   * event types, which keep their defining package across upgrades.
   * Defaults to `packageId` when the package was never upgraded.
   */
  typesPackageId?: string;
  registryId: string;
  coordinatorId: string;
  ikaCoinType: string;
}

function target(ids: PolicyIds, fn: string): string {
  return `${ids.packageId}::policy_wallet::${fn}`;
}

export function buildCreateWalletTx(
  ids: PolicyIds,
  params: {
    signers: string[];
    threshold: bigint;
    adminThreshold: bigint;
    timelockSpendMs: bigint;
    timelockAdminMs: bigint;
    requestExpiryMs: bigint;
    networkEncryptionKeyId: string;
    centralizedPublicKeyShareAndProof: Uint8Array;
    userPublicOutput: Uint8Array;
    publicUserSecretKeyShare: Uint8Array;
    sessionIdentifier: Uint8Array;
    ikaBudget: bigint;
    suiBudget: bigint;
  },
): Transaction {
  const tx = new Transaction();
  const ikaCoin = tx.add(
    coinWithBalance({ type: ids.ikaCoinType, balance: params.ikaBudget }),
  );
  const [suiCoin] = tx.splitCoins(tx.gas, [params.suiBudget]);
  tx.moveCall({
    target: target(ids, 'create_wallet'),
    arguments: [
      tx.object(ids.registryId),
      tx.object(ids.coordinatorId),
      tx.pure.vector('address', params.signers),
      tx.pure.u64(params.threshold),
      tx.pure.u64(params.adminThreshold),
      tx.pure.u64(params.timelockSpendMs),
      tx.pure.u64(params.timelockAdminMs),
      tx.pure.u64(params.requestExpiryMs),
      tx.pure.id(params.networkEncryptionKeyId),
      tx.pure(byteVec.serialize(params.centralizedPublicKeyShareAndProof)),
      tx.pure(byteVec.serialize(params.userPublicOutput)),
      tx.pure(byteVec.serialize(params.publicUserSecretKeyShare)),
      tx.pure(byteVec.serialize(params.sessionIdentifier)),
      ikaCoin,
      suiCoin,
    ],
  });
  return tx;
}

export function buildAddDwalletTx(
  ids: PolicyIds,
  walletId: string,
  params: {
    curve: number;
    centralizedPublicKeyShareAndProof: Uint8Array;
    userPublicOutput: Uint8Array;
    publicUserSecretKeyShare: Uint8Array;
    sessionIdentifier: Uint8Array;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'add_dwallet'),
    arguments: [
      tx.object(walletId),
      tx.object(ids.coordinatorId),
      tx.pure.u32(params.curve),
      tx.pure(byteVec.serialize(params.centralizedPublicKeyShareAndProof)),
      tx.pure(byteVec.serialize(params.userPublicOutput)),
      tx.pure(byteVec.serialize(params.publicUserSecretKeyShare)),
      tx.pure(byteVec.serialize(params.sessionIdentifier)),
    ],
  });
  return tx;
}

export function buildConfigureChainTx(
  ids: PolicyIds,
  walletId: string,
  params: {
    chainKey: Uint8Array;
    kind: number;
    evmChainId: bigint;
    fastPathLimit: bigint;
    perTxLimit: bigint;
    windowLimit: bigint;
    windowMs: bigint;
    feeLimit: bigint;
    allowlistEnabled: boolean;
    allowUnverified: boolean;
  },
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(ids, 'configure_chain'),
    arguments: [
      tx.object(walletId),
      tx.pure(byteVec.serialize(params.chainKey)),
      tx.pure.u8(params.kind),
      tx.pure.u128(params.evmChainId),
      tx.pure.u128(params.fastPathLimit),
      tx.pure.u128(params.perTxLimit),
      tx.pure.u128(params.windowLimit),
      tx.pure.u64(params.windowMs),
      tx.pure.u128(params.feeLimit),
      tx.pure.bool(params.allowlistEnabled),
      tx.pure.bool(params.allowUnverified),
    ],
  });
  return tx;
}

export function buildRecordAddressTx(
  ids: PolicyIds,
  walletId: string,
  chainKey: Uint8Array,
  identity: Uint8Array,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(ids, 'record_address'),
    arguments: [
      tx.object(walletId),
      tx.pure(byteVec.serialize(chainKey)),
      tx.pure(byteVec.serialize(identity)),
    ],
  });
  return tx;
}

export function buildSetupAllowlistAddTx(
  ids: PolicyIds,
  walletId: string,
  chainKey: Uint8Array,
  destination: Uint8Array,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(ids, 'setup_allowlist_add'),
    arguments: [
      tx.object(walletId),
      tx.pure(byteVec.serialize(chainKey)),
      tx.pure(byteVec.serialize(destination)),
    ],
  });
  return tx;
}

export function buildFinalizeSetupTx(
  ids: PolicyIds,
  walletId: string,
  tx = new Transaction(),
): Transaction {
  tx.moveCall({
    target: target(ids, 'finalize_setup'),
    arguments: [tx.object(walletId)],
  });
  return tx;
}

export function buildDepositBalancesTx(
  ids: PolicyIds,
  walletId: string,
  ikaAmount: bigint,
  suiAmount: bigint,
): Transaction {
  const tx = new Transaction();
  const ikaCoin = tx.add(coinWithBalance({ type: ids.ikaCoinType, balance: ikaAmount }));
  const [suiCoin] = tx.splitCoins(tx.gas, [suiAmount]);
  tx.moveCall({
    target: target(ids, 'deposit_balances'),
    arguments: [tx.object(walletId), ikaCoin, suiCoin],
  });
  return tx;
}

export function buildAddPresignTx(
  ids: PolicyIds,
  walletId: string,
  curve: number,
  signatureAlgorithm: number,
  count = 1,
  /**
   * Whether this (curve, algorithm) pair uses GLOBAL presigns on the live
   * Ika network. Current testnet/mainnet configs use global presigns for
   * all supported pairs, so this defaults to true; a wrong value aborts
   * harmlessly in the coordinator.
   */
  global = true,
): Transaction {
  const tx = new Transaction();
  for (let i = 0; i < count; i++) {
    tx.moveCall({
      target: target(ids, 'add_presign_v2'),
      arguments: [
        tx.object(walletId),
        tx.object(ids.coordinatorId),
        tx.pure.u32(curve),
        tx.pure.u32(signatureAlgorithm),
        tx.pure.bool(global),
      ],
    });
  }
  return tx;
}

export function buildVaultDepositTx(
  ids: PolicyIds,
  walletId: string,
  coinType: string,
  amount: bigint,
): Transaction {
  const tx = new Transaction();
  const deposit: TransactionObjectArgument =
    coinType === '0x2::sui::SUI'
      ? tx.splitCoins(tx.gas, [amount])[0]
      : tx.add(coinWithBalance({ type: coinType, balance: amount }));
  tx.moveCall({
    target: target(ids, 'vault_deposit'),
    typeArguments: [coinType],
    arguments: [tx.object(walletId), deposit],
  });
  return tx;
}

export function buildCreateSpendRequestTx(
  ids: PolicyIds,
  walletId: string,
  params: {
    chainKey: Uint8Array;
    asset: Uint8Array;
    destination: Uint8Array;
    amount: bigint;
    messages: Uint8Array[];
    centralizedSignatures: Uint8Array[];
    expectedPresignCapIds: string[];
    aux: Uint8Array[];
    unverified: boolean;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'create_spend_request'),
    arguments: [
      tx.object(walletId),
      tx.object(ids.coordinatorId),
      tx.pure(byteVec.serialize(params.chainKey)),
      tx.pure(byteVec.serialize(params.asset)),
      tx.pure(byteVec.serialize(params.destination)),
      tx.pure.u128(params.amount),
      tx.pure(byteVecVec.serialize(params.messages)),
      tx.pure(byteVecVec.serialize(params.centralizedSignatures)),
      tx.pure(idVec.serialize(params.expectedPresignCapIds)),
      tx.pure(byteVecVec.serialize(params.aux)),
      tx.pure.bool(params.unverified),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildCreateVaultSpendRequestTx(
  ids: PolicyIds,
  walletId: string,
  params: {
    chainKey: Uint8Array;
    coinTypeBytes: Uint8Array;
    destination: Uint8Array;
    amount: bigint;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'create_vault_spend_request'),
    arguments: [
      tx.object(walletId),
      tx.pure(byteVec.serialize(params.chainKey)),
      tx.pure(byteVec.serialize(params.coinTypeBytes)),
      tx.pure(byteVec.serialize(params.destination)),
      tx.pure.u128(params.amount),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildVoteSpendTx(
  ids: PolicyIds,
  walletId: string,
  requestId: bigint,
  approve: boolean,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'vote_spend'),
    arguments: [
      tx.object(walletId),
      tx.pure.u64(requestId),
      tx.pure.bool(approve),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildCancelSpendTx(
  ids: PolicyIds,
  walletId: string,
  requestId: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'cancel_spend'),
    arguments: [tx.object(walletId), tx.pure.u64(requestId)],
  });
  return tx;
}

export function buildExecuteSpendTx(
  ids: PolicyIds,
  walletId: string,
  requestId: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'execute_spend'),
    arguments: [
      tx.object(walletId),
      tx.object(ids.coordinatorId),
      tx.pure.u64(requestId),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildExecuteVaultSpendTx(
  ids: PolicyIds,
  walletId: string,
  requestId: bigint,
  coinType: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'execute_vault_spend'),
    typeArguments: [coinType],
    arguments: [tx.object(walletId), tx.pure.u64(requestId), tx.object(CLOCK)],
  });
  return tx;
}

export function buildPauseTx(ids: PolicyIds, walletId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'pause'),
    arguments: [tx.object(walletId)],
  });
  return tx;
}

export function buildCreateProposalTx(
  ids: PolicyIds,
  walletId: string,
  params: {
    action: number;
    chainKey: Uint8Array;
    addrParam: string | null;
    bytesParam: Uint8Array;
    uParams: bigint[];
    boolParam: boolean;
  },
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'create_proposal'),
    arguments: [
      tx.object(walletId),
      tx.pure.u8(params.action),
      tx.pure(byteVec.serialize(params.chainKey)),
      tx.pure(bcs.option(bcs.Address).serialize(params.addrParam)),
      tx.pure(byteVec.serialize(params.bytesParam)),
      tx.pure(u128Vec.serialize(params.uParams)),
      tx.pure.bool(params.boolParam),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildVoteProposalTx(
  ids: PolicyIds,
  walletId: string,
  proposalId: bigint,
  approve: boolean,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'vote_proposal'),
    arguments: [
      tx.object(walletId),
      tx.pure.u64(proposalId),
      tx.pure.bool(approve),
      tx.object(CLOCK),
    ],
  });
  return tx;
}

export function buildExecuteProposalTx(
  ids: PolicyIds,
  walletId: string,
  proposalId: bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target(ids, 'execute_proposal'),
    arguments: [
      tx.object(walletId),
      tx.object(ids.registryId),
      tx.pure.u64(proposalId),
      tx.object(CLOCK),
    ],
  });
  return tx;
}
