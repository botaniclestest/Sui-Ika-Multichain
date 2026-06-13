/** Core wiring for the app: clients, ids, recovery, spend flows. */

import { useDAppKit, useCurrentAccount } from '@mysten/dapp-kit-react';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Transaction } from '@mysten/sui/transactions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChainKind,
  Curve,
  Hash,
  IkaCurve,
  IkaService,
  SignatureAlgorithm,
  type PolicyIds,
  type RecoveredWallet,
  type SuiNetwork,
  buildBtcSpend,
  buildCreateSpendRequestTx,
  buildEvmTransfer,
  buildErc20Transfer,
  buildSolDurableTransfer,
  createDurableNonceAccount,
  addressToScript,
  checkBtcIntent,
  checkEvmIntent,
  checkSolIntent,
  discoverWallets,
  evmAddressBytes,
  fetchEvmTxParams,
  fetchFeeRate,
  fetchUtxos,
  getWalletState,
  p2wpkhScript,
  recoverWallet,
  resolveConfig,
  solanaAddressBytes,
  utf8,
  hashFromNumbers,
  sigAlgFromNumbers,
  curveFromNumber,
} from '@mythos/wallet-core';
import { BTC_NETWORK_FOR, getDeployment } from './config';

const RPC = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
} as const;

export interface CoreCtx {
  network: SuiNetwork;
  sui: SuiJsonRpcClient;
  ika: IkaService;
  ids: PolicyIds | null;
}

const serviceCache = new Map<string, { sui: SuiJsonRpcClient; ika: IkaService }>();

export function useCore(network: SuiNetwork): CoreCtx {
  const cached = serviceCache.get(network);
  const { sui, ika } = useMemo(() => {
    if (cached) return cached;
    const sui = new SuiJsonRpcClient({ url: RPC[network], network });
    const ika = new IkaService(sui as never, network);
    const entry = { sui, ika };
    serviceCache.set(network, entry);
    return entry;
  }, [network, cached]);

  const [coordinatorReady, setCoordinatorReady] = useState(false);
  useEffect(() => {
    ika.init().then(() => setCoordinatorReady(true)).catch(console.error);
  }, [ika]);

  const ids = useMemo<PolicyIds | null>(() => {
    const dep = getDeployment(network);
    if (!dep || !coordinatorReady) return null;
    return {
      packageId: dep.latestPackageId ?? dep.policyPackageId,
      typesPackageId: dep.policyPackageId,
      registryId: dep.registryId,
      coordinatorId: ika.coordinatorObjectId,
      ikaCoinType: ika.ikaCoinType,
    };
  }, [network, ika, coordinatorReady]);

  return { network, sui, ika, ids };
}

export function useExec() {
  const dAppKit = useDAppKit();
  return useCallback(
    async (transaction: Transaction, label: string) => {
      const result = await dAppKit.signAndExecuteTransaction({ transaction });
      const digest =
        'Transaction' in result && result.Transaction && 'digest' in result.Transaction
          ? (result.Transaction as { digest: string }).digest
          : 'unknown';
      console.log(`${label}: ${digest}`);
      return result;
    },
    [dAppKit],
  );
}

export function useMyWallets(core: CoreCtx) {
  const account = useCurrentAccount();
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!account || !core.ids) return;
    setLoading(true);
    try {
      const found = await discoverWallets(
        core.sui as never,
        core.ids.typesPackageId ?? core.ids.packageId,
        core.ids.registryId,
        account.address,
      );
      setWallets(found);
    } finally {
      setLoading(false);
    }
  }, [account, core.ids, core.sui]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { wallets, loading, refresh };
}

export function useRecoveredWallet(core: CoreCtx, walletId: string | null) {
  const [data, setData] = useState<RecoveredWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!walletId) return;
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const recovered = await recoverWallet(
        core.sui as never,
        core.ika,
        walletId,
        BTC_NETWORK_FOR[core.network],
      );
      if (gen === generation.current) setData(recovered);
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [core, walletId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

export interface SpendDraft {
  chainKey: string;
  destination: string; // chain-native address string
  amountBaseUnits: bigint;
  /** ERC-20 token contract (EVM only, optional) */
  tokenAddress?: string;
}

/**
 * Prepares and submits a spend request for any Ika-signed chain:
 * builds the exact transaction bytes, mirrors the on-chain intent check
 * locally, computes the centralized signatures against the presigns the
 * contract will consume, and submits the request PTB.
 */
export function useCreateSpend(core: CoreCtx) {
  const exec = useExec();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const createSpend = useCallback(
    async (walletId: string, recovered: RecoveredWallet, draft: SpendDraft) => {
      if (!core.ids) throw new Error('deployment not configured');
      setBusy(true);
      try {
        const chain = recovered.state.chains.get(draft.chainKey);
        if (!chain) throw new Error(`chain ${draft.chainKey} not configured`);
        const cfg = resolveConfig(core.network);

        // Vault spends take the simpler path (handled by caller).
        if (chain.kind === ChainKind.SuiVault) throw new Error('use vault flow');

        setStatus('loading dWallet...');
        const dwalletId = recovered.state.dwallets.get(chain.curve);
        if (!dwalletId) throw new Error(`no dWallet for curve ${chain.curve}`);
        const dwallet = await core.ika.getActiveDWallet(dwalletId);

        // --- build chain-specific payload ---
        setStatus('building transaction...');
        let messages: Uint8Array[];
        let aux: Uint8Array[] = [];
        let destinationBytes: Uint8Array;
        let assetBytes: Uint8Array = new Uint8Array();

        if (chain.kind === ChainKind.Btc) {
          const btcNet = BTC_NETWORK_FOR[core.network];
          const addr = recovered.addresses.find((a) => a.chainKey === draft.chainKey);
          if (!addr) throw new Error('btc address unknown');
          const [utxos, feeRate] = await Promise.all([
            fetchUtxos(cfg.btcEsploraUrl, addr.address),
            fetchFeeRate(cfg.btcEsploraUrl),
          ]);
          destinationBytes = addressToScript(draft.destination, btcNet);
          const plan = buildBtcSpend({
            utxos,
            publicKey: dwallet.publicKey,
            destinationScript: destinationBytes,
            amount: draft.amountBaseUnits,
            feeRateSatVb: feeRate,
            network: btcNet,
          });
          const check = checkBtcIntent({
            messages: plan.messages,
            outputsBytes: plan.outputsBytes,
            prevoutsBytes: plan.prevoutsBytes,
            ownScript: p2wpkhScript(dwallet.publicKey),
            destinationScript: destinationBytes,
            amount: draft.amountBaseUnits,
            feeLimit: chain.feeLimit,
          });
          if (!check.ok) throw new Error(`intent check failed: ${check.errors.join('; ')}`);
          messages = plan.messages;
          aux = [plan.outputsBytes, plan.prevoutsBytes];
        } else if (chain.kind === ChainKind.Evm) {
          const rpc = cfg.evmRpcUrls[draft.chainKey];
          if (!rpc) throw new Error(`no RPC for ${draft.chainKey}`);
          const addr = recovered.addresses.find((a) => a.chainKey === draft.chainKey);
          if (!addr) throw new Error('evm address unknown');
          const isToken = !!draft.tokenAddress;
          const params = await fetchEvmTxParams(rpc, addr.address, isToken);
          destinationBytes = evmAddressBytes(draft.destination);
          const plan = isToken
            ? buildErc20Transfer({
                chainId: chain.evmChainId,
                nonce: params.nonce,
                maxFeePerGas: params.maxFeePerGas,
                maxPriorityFeePerGas: params.maxPriorityFeePerGas,
                gasLimit: params.gasLimit,
                token: draft.tokenAddress!,
                to: draft.destination,
                amount: draft.amountBaseUnits,
              })
            : buildEvmTransfer({
                chainId: chain.evmChainId,
                nonce: params.nonce,
                maxFeePerGas: params.maxFeePerGas,
                maxPriorityFeePerGas: params.maxPriorityFeePerGas,
                gasLimit: params.gasLimit,
                to: draft.destination,
                value: draft.amountBaseUnits,
              });
          if (isToken) assetBytes = evmAddressBytes(draft.tokenAddress!);
          const check = checkEvmIntent({
            message: plan.message,
            chainId: chain.evmChainId,
            asset: assetBytes,
            destination: destinationBytes,
            amount: draft.amountBaseUnits,
            feeLimit: chain.feeLimit,
          });
          if (!check.ok) throw new Error(`intent check failed: ${check.errors.join('; ')}`);
          messages = [plan.message];
        } else if (chain.kind === ChainKind.Solana) {
          // Durable nonce: a recent blockhash expires in ~60-90s, far less
          // than multisig voting takes. The nonce account's authority is the
          // wallet itself, so only the policy-gated signature can use it.
          // Rent is paid faucet-free by a connected Solana wallet or the
          // local dust-only gas tank (identical on devnet and mainnet).
          const { resolveSolanaPayer } = await import('./solana-gas');
          const resolved = await resolveSolanaPayer();
          setStatus(`creating durable nonce account (rent via ${resolved.source}: ${resolved.address.slice(0, 8)}...)`);
          const nonce = await createDurableNonceAccount(
            cfg.solanaRpcUrl,
            dwallet.publicKey,
            resolved.payer,
          );
          destinationBytes = solanaAddressBytes(draft.destination);
          const plan = buildSolDurableTransfer({
            fromPubkey: dwallet.publicKey,
            to: draft.destination,
            lamports: draft.amountBaseUnits,
            nonce,
          });
          const check = checkSolIntent({
            message: plan.message,
            ownPubkey: dwallet.publicKey,
            destination: destinationBytes,
            amount: draft.amountBaseUnits,
          });
          if (!check.ok) throw new Error(`intent check failed: ${check.errors.join('; ')}`);
          messages = [plan.message];
        } else {
          throw new Error('unsupported chain kind');
        }

        // --- pair with the presigns the contract will pop (LIFO) ---
        setStatus('pairing presigns...');
        const state = await getWalletState(core.sui as never, walletId);
        const poolKey = `${chain.curve}:${chain.signatureAlgorithm}`;
        const pool = state.presignPools.get(poolKey) ?? [];
        if (pool.length < messages.length) {
          throw new Error(
            `need ${messages.length} presign(s), pool has ${pool.length}. Add presigns first.`,
          );
        }
        const consumed = pool.slice(-messages.length).reverse();
        const expectedPresignCapIds = consumed.map((p) => p.capId);

        setStatus('computing centralized signatures...');
        const curve = curveFromNumber(chain.curve);
        const sigAlg = sigAlgFromNumbers(chain.curve, chain.signatureAlgorithm);
        const hash = hashFromNumbers(chain.curve, chain.signatureAlgorithm, chain.hashScheme);
        const centralizedSignatures: Uint8Array[] = [];
        for (let i = 0; i < messages.length; i++) {
          const presignBytes = await core.ika.getCompletedPresignBytes(consumed[i].presignId);
          centralizedSignatures.push(
            await core.ika.computeCentralizedSignature({
              dwallet,
              presignBytes,
              message: messages[i],
              hash,
              signatureAlgorithm: sigAlg,
              curve,
            }),
          );
        }

        setStatus('submitting request...');
        const tx = buildCreateSpendRequestTx(core.ids, walletId, {
          chainKey: utf8(draft.chainKey),
          asset: assetBytes,
          destination: destinationBytes,
          amount: draft.amountBaseUnits,
          messages,
          centralizedSignatures,
          expectedPresignCapIds,
          aux,
          unverified: false,
        });
        await exec(tx, 'create_spend_request');
        setStatus('request created');
      } finally {
        setBusy(false);
      }
    },
    [core, exec],
  );

  return { createSpend, busy, status };
}

export { Curve, Hash, IkaCurve, SignatureAlgorithm };
