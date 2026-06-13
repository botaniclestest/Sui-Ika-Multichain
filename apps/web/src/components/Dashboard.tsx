/**
 * Wallet dashboard: everything reads from chain state via the recovery
 * pipeline, so this page renders identically on any rebuilt frontend.
 */

import { useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { Transaction as EthersTransaction } from 'ethers';
import {
  ChainKind,
  ProposalAction,
  RequestStatus,
  type AdminProposalState,
  type RecoveredWallet,
  type SpendRequestState,
  assembleBtcTransaction,
  assembleEvmTransaction,
  assembleSolTransaction,
  broadcastBtc,
  broadcastEvm,
  broadcastSol,
  btcAssemblyFromRequest,
  buildAddPresignTx,
  buildCreateProposalTx,
  buildCreateVaultSpendRequestTx,
  buildDepositBalancesTx,
  buildExecuteSpendTx,
  buildExecuteVaultSpendTx,
  buildPauseTx,
  buildVaultDepositTx,
  buildVoteProposalTx,
  buildVoteSpendTx,
  bytesToHex,
  chainDescriptor,
  checkBtcIntent,
  checkEvmIntent,
  checkSolIntent,
  curveFromNumber,
  describeUnverifiedPayload,
  hexToBytes,
  p2wpkhScript,
  resolveConfig,
  sigAlgFromNumbers,
  solanaAddressBytes,
  utf8,
  buildExecuteProposalTx,
} from '@mythos/wallet-core';
import { BTC_NETWORK_FOR } from '../config';
import { useCreateSpend, useExec, useRecoveredWallet, type CoreCtx } from '../hooks';

function fmtUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

function toBase(human: string, decimals: number): bigint {
  const [whole, frac = ''] = human.trim().split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

const STATUS_LABEL: Record<number, string> = {
  [RequestStatus.Pending]: 'pending',
  [RequestStatus.Executed]: 'executed',
  [RequestStatus.Rejected]: 'rejected',
  [RequestStatus.Cancelled]: 'cancelled',
  [RequestStatus.Expired]: 'expired',
};

export function Dashboard({
  core,
  walletId,
  onBack,
}: {
  core: CoreCtx;
  walletId: string;
  onBack: () => void;
}) {
  const account = useCurrentAccount();
  const exec = useExec();
  const { data, error, loading, refresh } = useRecoveredWallet(core, walletId);
  const [tab, setTab] = useState<'overview' | 'send' | 'requests' | 'governance'>('overview');
  const [busyMsg, setBusyMsg] = useState('');

  if (error) return <main className="card error">{error}</main>;
  if (!data) return <main className="card">Recovering wallet state from chain...</main>;

  const isSigner = !!account && data.state.signers.includes(account.address);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusyMsg(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      alert(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusyMsg('');
    }
  }

  return (
    <main>
      <div className="row spread">
        <h2>
          <button onClick={onBack}>&larr;</button> wallet {walletId.slice(0, 10)}...{' '}
          {data.state.paused && <span className="badge danger">PAUSED</span>}
        </h2>
        <div>
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? 'refreshing...' : 'refresh'}
          </button>{' '}
          {isSigner && !data.state.paused && core.ids && (
            <button
              className="danger"
              onClick={() =>
                act('pause', () => exec(buildPauseTx(core.ids!, walletId), 'pause'))
              }
            >
              EMERGENCY PAUSE
            </button>
          )}
        </div>
      </div>

      {data.warnings.map((w, i) => (
        <div key={i} className="warning">
          {w}
        </div>
      ))}
      {busyMsg && <div className="progress-line">{busyMsg}...</div>}

      <nav className="tabs">
        {(['overview', 'send', 'requests', 'governance'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'requests' && data.pendingRequests.length > 0 && (
              <span className="badge">{data.pendingRequests.length}</span>
            )}
            {t === 'governance' && data.pendingProposals.length > 0 && (
              <span className="badge">{data.pendingProposals.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview core={core} walletId={walletId} data={data} act={act} />}
      {tab === 'send' && (
        <SendTab core={core} walletId={walletId} data={data} isSigner={isSigner} onSubmitted={refresh} />
      )}
      {tab === 'requests' && (
        <RequestsTab core={core} walletId={walletId} data={data} isSigner={isSigner} act={act} />
      )}
      {tab === 'governance' && (
        <GovernanceTab core={core} walletId={walletId} data={data} isSigner={isSigner} act={act} />
      )}
    </main>
  );
}

// === Overview ===

function Overview({
  core,
  walletId,
  data,
  act,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const exec = useExec();
  return (
    <section>
      <div className="card">
        <h3>Signers ({data.state.threshold.toString()}-of-{data.state.signers.length}, admin {data.state.adminThreshold.toString()})</h3>
        <ul className="mono">
          {data.state.signers.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="muted">
          spend timelock {Number(data.state.timelockSpendMs) / 3_600_000}h · admin timelock{' '}
          {Number(data.state.timelockAdminMs) / 3_600_000}h · request expiry{' '}
          {Number(data.state.requestExpiryMs) / 3_600_000}h
        </p>
      </div>

      <div className="card">
        <h3>Addresses (re-derived from Ika dWallet public keys)</h3>
        <table>
          <tbody>
            {data.addresses.map((a) => (
              <tr key={a.chainKey}>
                <td>{a.chainKey}</td>
                <td className="mono">{a.address || '(dWallet pending)'}</td>
                <td>{a.verified ? <span className="badge ok">verified</span> : <span className="badge danger">UNVERIFIED</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          "verified" = the on-chain recorded identity matches what this client independently
          derives from the dWallet public output. Never approve spends on an unverified chain.
        </p>
      </div>

      <div className="card">
        <h3>Policies</h3>
        <table>
          <thead>
            <tr>
              <th>chain</th><th>per-tx</th><th>fast path</th><th>window</th><th>spent (window)</th><th>fee cap</th><th>flags</th>
            </tr>
          </thead>
          <tbody>
            {[...data.state.chains.values()].map((c) => {
              const dec = chainDescriptor(c.chainKey)?.decimals ?? 0;
              return (
                <tr key={c.chainKey} className={c.enabled ? '' : 'disabled'}>
                  <td>{c.chainKey}</td>
                  <td>{fmtUnits(c.perTxLimit, dec)}</td>
                  <td>{fmtUnits(c.fastPathLimit, dec)}</td>
                  <td>
                    {fmtUnits(c.windowLimit, dec)} / {Number(c.windowMs) / 3_600_000}h
                  </td>
                  <td>{fmtUnits(c.spentInWindow, dec)}</td>
                  <td>{fmtUnits(c.feeLimit, dec)}</td>
                  <td className="muted">
                    {!c.enabled && 'disabled '}
                    {c.allowlistEnabled && 'allowlist '}
                    {c.allowUnverified && 'unverified-ok '}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Operations</h3>
        <p>
          fee reserves: {fmtUnits(data.state.ikaBalance, 9)} IKA · {fmtUnits(data.state.suiBalance, 9)} SUI
          {'  '}· presigns:{' '}
          {[...data.state.presignPools.entries()]
            .map(([k, v]) => `${k} -> ${v.length}`)
            .join(', ') || 'none'}
        </p>
        {core.ids && (
          <div className="row">
            <button
              onClick={() =>
                act('deposit fee reserves', () =>
                  exec(buildDepositBalancesTx(core.ids!, walletId, 2_000_000_000n, 500_000_000n), 'deposit'),
                )
              }
            >
              deposit 2 IKA + 0.5 SUI
            </button>
            <button
              onClick={() =>
                act('add presign', () =>
                  exec(buildAddPresignTx(core.ids!, walletId, 0, 0, 1), 'presign'),
                )
              }
            >
              + secp256k1 presign
            </button>
            {data.state.dwallets.has(2) && (
              <button
                onClick={() =>
                  act('add presign', () =>
                    exec(buildAddPresignTx(core.ids!, walletId, 2, 0, 1), 'presign'),
                  )
                }
              >
                + ed25519 presign
              </button>
            )}
            <button
              onClick={() =>
                act('vault deposit', () =>
                  exec(buildVaultDepositTx(core.ids!, walletId, '0x2::sui::SUI', 1_000_000_000n), 'vault'),
                )
              }
            >
              deposit 1 SUI to vault
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// === Send ===

function SendTab({
  core,
  walletId,
  data,
  isSigner,
  onSubmitted,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  isSigner: boolean;
  onSubmitted: () => Promise<void>;
}) {
  const exec = useExec();
  const { createSpend, busy, status } = useCreateSpend(core);
  const chains = [...data.state.chains.values()].filter((c) => c.enabled);
  const [chainKey, setChainKey] = useState(chains[0]?.chainKey ?? '');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const chain = data.state.chains.get(chainKey);
  const dec = chainDescriptor(chainKey)?.decimals ?? 9;
  const destinationHint =
    chain?.kind === ChainKind.SuiVault
      ? '(0x Sui address)'
      : chain?.kind === ChainKind.Solana
        ? '(base58 Solana address)'
        : chain?.kind === ChainKind.Evm
          ? '(0x EVM address)'
          : chain?.kind === ChainKind.Btc
            ? '(Bitcoin address)'
            : '(chain-native address)';

  if (!isSigner) return <section className="card">Connect as a signer to send.</section>;
  if (data.state.paused) return <section className="card error">Wallet is paused.</section>;

  async function submit() {
    setErr(null);
    try {
      if (!chain || !core.ids) throw new Error('select a chain');
      const amountBase = toBase(amount, dec);
      if (chain.kind === ChainKind.Solana) {
        if (destination.startsWith('0x')) {
          throw new Error('Solana destination must be a base58 Solana address, not a 0x Sui/EVM address.');
        }
        try {
          solanaAddressBytes(destination);
        } catch {
          throw new Error('Invalid Solana destination. Enter a base58 Solana public key.');
        }
      }
      if (chain.kind === ChainKind.SuiVault) {
        const coinType = '0x2::sui::SUI';
        const tx = buildCreateVaultSpendRequestTx(core.ids, walletId, {
          chainKey: utf8(chainKey),
          coinTypeBytes: utf8(coinType.replace('0x2', '0000000000000000000000000000000000000000000000000000000000000002')),
          destination: hexToBytes(destination),
          amount: amountBase,
        });
        await exec(tx, 'vault spend request');
      } else {
        await createSpend(walletId, data, {
          chainKey,
          destination,
          amountBaseUnits: amountBase,
          tokenAddress: token || undefined,
        });
      }
      setDestination('');
      setAmount('');
      await onSubmitted();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h3>New spend request</h3>
      <div className="form">
        <label>
          Chain
          <select value={chainKey} onChange={(e) => setChainKey(e.target.value)}>
            {chains.map((c) => (
              <option key={c.chainKey} value={c.chainKey}>
                {chainDescriptor(c.chainKey)?.displayName ?? c.chainKey}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination {destinationHint}
          <input value={destination} onChange={(e) => setDestination(e.target.value.trim())} />
        </label>
        <label>
          Amount ({chainDescriptor(chainKey)?.symbol ?? 'units'})
          <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
        </label>
        {chain?.kind === ChainKind.Evm && (
          <label>
            ERC-20 token contract (leave empty for native)
            <input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="0x... (optional)" />
          </label>
        )}
        {chain && (
          <p className="muted">
            policy: per-tx max {fmtUnits(chain.perTxLimit, dec)} · fast path&nbsp;
            {fmtUnits(chain.fastPathLimit, dec)} (1 approval, no timelock) · window&nbsp;
            {fmtUnits(chain.windowLimit - chain.spentInWindow, dec)} remaining
          </p>
        )}
        {status && <div className="progress-line">{status}</div>}
        {err && <div className="error">{err}</div>}
        <button className="primary" onClick={() => void submit()} disabled={busy || !destination || !amount}>
          {busy ? 'preparing...' : 'create spend request'}
        </button>
      </div>
    </section>
  );
}

// === Requests ===

function RequestsTab({
  core,
  walletId,
  data,
  isSigner,
  act,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  isSigner: boolean;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const exec = useExec();
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

  async function executeAndBroadcast(req: SpendRequestState) {
    if (!core.ids) return;
    const chain = data.state.chains.get(req.chainKey);
    if (!chain) throw new Error('chain unknown');

    if (chain.kind === ChainKind.SuiVault) {
      // coin type bytes are the stored asset
      const coinType = '0x' + new TextDecoder().decode(req.asset).replace(/^0+/, '0');
      await exec(buildExecuteVaultSpendTx(core.ids, walletId, req.id, coinType), 'execute vault spend');
      return;
    }

    // 1. execute on Sui (this is where the policy finally releases approvals)
    if (req.status === RequestStatus.Pending) {
      // the locked partial signatures must finish network verification first
      for (const id of req.partialSigIds) {
        await core.ika.waitForPartialSignatureVerified(id);
      }
      await exec(buildExecuteSpendTx(core.ids, walletId, req.id), 'execute_spend');
    }

    // 2. collect Ika signatures
    const fresh = (await import('@mythos/wallet-core')).getSpendRequest;
    const updated = await fresh(core.sui as never, walletId, req.id);
    if (updated.signIds.length === 0) throw new Error('no sign sessions recorded');
    const curve = curveFromNumber(chain.curve);
    const alg = sigAlgFromNumbers(chain.curve, chain.signatureAlgorithm);
    const signatures: Uint8Array[] = [];
    for (const signId of updated.signIds) {
      signatures.push(await core.ika.waitForSignature(signId, curve, alg));
    }

    // 3. assemble + broadcast on the target chain
    const cfg = resolveConfig(core.network);
    const dwalletId = data.state.dwallets.get(chain.curve)!;
    const dwallet = await core.ika.getActiveDWallet(dwalletId);

    if (chain.kind === ChainKind.Btc) {
      const assembly = btcAssemblyFromRequest(updated.messages, updated.aux, dwallet.publicKey);
      const txHex = assembleBtcTransaction(assembly, updated.messages, signatures);
      const txid = await broadcastBtc(cfg.btcEsploraUrl, txHex);
      setBroadcastResult(`BTC txid: ${txid}`);
    } else if (chain.kind === ChainKind.Evm) {
      const unsignedHex = bytesToHex(updated.messages[0], true);
      const addrInfo = data.addresses.find((a) => a.chainKey === req.chainKey)!;
      const signed = assembleEvmTransaction({ unsignedSerializedHex: unsignedHex }, signatures[0], addrInfo.address);
      const rpc = cfg.evmRpcUrls[req.chainKey];
      const hash = await broadcastEvm(rpc, signed);
      setBroadcastResult(`EVM tx: ${hash}`);
    } else if (chain.kind === ChainKind.Solana) {
      const messageBase64 = btoa(String.fromCharCode(...updated.messages[0]));
      const wire = assembleSolTransaction({ messageBase64 }, signatures[0]);
      const sig = await broadcastSol(cfg.solanaRpcUrl, wire);
      setBroadcastResult(`Solana sig: ${sig}`);
    }
  }

  const all = [...data.pendingRequests];

  return (
    <section>
      {broadcastResult && <div className="card ok">{broadcastResult}</div>}
      {all.length === 0 && <p>No pending requests.</p>}
      {all.map((req) => (
        <RequestCard
          key={req.id.toString()}
          core={core}
          data={data}
          req={req}
          isSigner={isSigner}
          onVote={(approve) =>
            act(approve ? 'approve' : 'reject', () =>
              exec(buildVoteSpendTx(core.ids!, walletId, req.id, approve), 'vote'),
            )
          }
          onExecute={() => act('execute + broadcast', () => executeAndBroadcast(req))}
        />
      ))}
    </section>
  );
}

function RequestCard({
  core,
  data,
  req,
  isSigner,
  onVote,
  onExecute,
}: {
  core: CoreCtx;
  data: RecoveredWallet;
  req: SpendRequestState;
  isSigner: boolean;
  onVote: (approve: boolean) => Promise<void>;
  onExecute: () => Promise<void>;
}) {
  const account = useCurrentAccount();
  const chain = data.state.chains.get(req.chainKey);
  const dec = chainDescriptor(req.chainKey)?.decimals ?? 9;
  const alreadyVoted =
    !!account && (req.approvals.includes(account.address) || req.rejections.includes(account.address));

  // independent client-side verification before voting (mirrors Move)
  const intentCheck = useMemo(() => {
    if (!chain) return { ok: false, errors: ['unknown chain'], summary: '' };
    try {
      if (chain.kind === ChainKind.SuiVault) {
        return { ok: true, errors: [], summary: `Vault transfer of ${fmtUnits(req.amount, 9)} to 0x${bytesToHex(req.destination)}` };
      }
      if (!req.verifiedIntent) {
        return { ok: false, errors: ['UNVERIFIED payload - review bytes manually'], summary: describeUnverifiedPayload(req.messages[0] ?? new Uint8Array()) };
      }
      if (chain.kind === ChainKind.Btc) {
        const ownScript = data.state.addressBook.get(req.chainKey) ?? new Uint8Array();
        return checkBtcIntent({
          messages: req.messages,
          outputsBytes: req.aux[0] ?? new Uint8Array(),
          prevoutsBytes: req.aux[1] ?? new Uint8Array(),
          ownScript,
          destinationScript: req.destination,
          amount: req.amount,
          feeLimit: chain.feeLimit,
        });
      }
      if (chain.kind === ChainKind.Evm) {
        return checkEvmIntent({
          message: req.messages[0],
          chainId: chain.evmChainId,
          asset: req.asset,
          destination: req.destination,
          amount: req.amount,
          feeLimit: chain.feeLimit,
        });
      }
      if (chain.kind === ChainKind.Solana) {
        const own = data.state.addressBook.get(req.chainKey) ?? new Uint8Array();
        return checkSolIntent({
          message: req.messages[0],
          ownPubkey: own,
          destination: req.destination,
          amount: req.amount,
        });
      }
      return { ok: false, errors: ['unsupported kind'], summary: '' };
    } catch (e) {
      return { ok: false, errors: [(e as Error).message], summary: '' };
    }
  }, [chain, data, req]);

  const required = Number(data.state.threshold);
  const reached = req.thresholdReachedAtMs > 0n;
  const decoded = (() => {
    if (chain?.kind === ChainKind.Evm && req.messages[0]) {
      try {
        const t = EthersTransaction.from(bytesToHex(req.messages[0], true));
        return `nonce ${t.nonce}, gas ${t.gasLimit}, maxFee ${t.maxFeePerGas}`;
      } catch {
        return '';
      }
    }
    return '';
  })();

  return (
    <div className="card request">
      <div className="row spread">
        <strong>
          #{req.id.toString()} {req.chainKey} · {fmtUnits(req.amount, dec)}{' '}
          {chainDescriptor(req.chainKey)?.symbol}
        </strong>
        <span className={`badge ${req.status === 0 ? '' : 'ok'}`}>{STATUS_LABEL[req.status]}</span>
      </div>
      <div className="mono small">to {bytesToHex(req.destination, chain?.kind === ChainKind.Evm)}</div>
      {decoded && <div className="muted small">{decoded}</div>}
      <div className={intentCheck.ok ? 'ok small' : 'error small'}>
        {intentCheck.ok ? `verified: ${intentCheck.summary}` : `CHECK FAILED: ${intentCheck.errors.join('; ')}`}
      </div>
      <div className="small">
        approvals {req.approvals.length}/{required} · rejections {req.rejections.length} ·{' '}
        {reached ? 'threshold reached' : 'collecting votes'} · creator {req.creator.slice(0, 8)}...
      </div>
      {isSigner && req.status === RequestStatus.Pending && (
        <div className="row">
          {!alreadyVoted && (
            <>
              <button className="primary" disabled={!intentCheck.ok} onClick={() => void onVote(true)}>
                approve
              </button>
              <button className="danger" onClick={() => void onVote(false)}>
                reject
              </button>
            </>
          )}
          {reached && (
            <button className="primary" onClick={() => void onExecute()}>
              execute + broadcast
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// === Governance ===

const ACTION_LABEL: Record<number, string> = {
  [ProposalAction.AddSigner]: 'add signer',
  [ProposalAction.RemoveSigner]: 'remove signer',
  [ProposalAction.SetThresholds]: 'set thresholds',
  [ProposalAction.SetTimelocks]: 'set timelocks',
  [ProposalAction.SetExpiry]: 'set expiry',
  [ProposalAction.SetChainLimits]: 'set chain limits',
  [ProposalAction.AllowlistAdd]: 'allowlist add',
  [ProposalAction.AllowlistRemove]: 'allowlist remove',
  [ProposalAction.BlocklistAdd]: 'blocklist add',
  [ProposalAction.BlocklistRemove]: 'blocklist remove',
  [ProposalAction.Unpause]: 'UNPAUSE',
  [ProposalAction.SetAddressBook]: 'set address book',
  [ProposalAction.SetChainEnabled]: 'enable/disable chain',
  [ProposalAction.SetAllowlistEnabled]: 'toggle allowlist',
  [ProposalAction.SetAllowUnverified]: 'toggle unverified payloads',
};

function GovernanceTab({
  core,
  walletId,
  data,
  isSigner,
  act,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  isSigner: boolean;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const exec = useExec();
  const [action, setAction] = useState<number>(ProposalAction.AddSigner);
  const [addrParam, setAddrParam] = useState('');
  const [chainKey, setChainKey] = useState('');
  const [u1, setU1] = useState('');
  const [u2, setU2] = useState('');
  const [boolParam, setBoolParam] = useState(true);
  const [bytesParam, setBytesParam] = useState('');

  async function createProposal() {
    if (!core.ids) return;
    const uParams: bigint[] = [];
    if (action === ProposalAction.SetThresholds || action === ProposalAction.SetTimelocks) {
      uParams.push(BigInt(u1 || '0'), BigInt(u2 || '0'));
    } else if (action === ProposalAction.SetExpiry) {
      uParams.push(BigInt(u1 || '0'));
    }
    const needsAddr = action === ProposalAction.AddSigner || action === ProposalAction.RemoveSigner;
    const tx = buildCreateProposalTx(core.ids, walletId, {
      action,
      chainKey: chainKey ? utf8(chainKey) : new Uint8Array(),
      addrParam: needsAddr ? addrParam : null,
      bytesParam: bytesParam ? hexToBytes(bytesParam) : new Uint8Array(),
      uParams,
      boolParam,
    });
    await act('create proposal', () => exec(tx, 'create_proposal'));
  }

  return (
    <section>
      {data.pendingProposals.map((p) => (
        <ProposalCard
          key={p.id.toString()}
          core={core}
          walletId={walletId}
          data={data}
          proposal={p}
          isSigner={isSigner}
          act={act}
        />
      ))}

      {isSigner && (
        <div className="card">
          <h3>New admin proposal</h3>
          <p className="muted">
            Admin actions need {data.state.adminThreshold.toString()} approvals, then wait{' '}
            {Number(data.state.timelockAdminMs) / 3_600_000}h (veto window) before execution.
          </p>
          <div className="form">
            <label>
              Action
              <select value={action} onChange={(e) => setAction(parseInt(e.target.value))}>
                {Object.entries(ACTION_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {(action === ProposalAction.AddSigner || action === ProposalAction.RemoveSigner) && (
              <label>
                Signer address
                <input value={addrParam} onChange={(e) => setAddrParam(e.target.value.trim())} />
              </label>
            )}
            {action >= ProposalAction.SetChainLimits && action !== ProposalAction.Unpause && (
              <label>
                Chain key
                <select value={chainKey} onChange={(e) => setChainKey(e.target.value)}>
                  <option value="">select...</option>
                  {[...data.state.chains.keys()].map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(action === ProposalAction.SetThresholds || action === ProposalAction.SetTimelocks) && (
              <div className="row">
                <label>
                  {action === ProposalAction.SetThresholds ? 'spend threshold' : 'spend timelock (ms)'}
                  <input value={u1} onChange={(e) => setU1(e.target.value)} />
                </label>
                <label>
                  {action === ProposalAction.SetThresholds ? 'admin threshold' : 'admin timelock (ms)'}
                  <input value={u2} onChange={(e) => setU2(e.target.value)} />
                </label>
              </div>
            )}
            {action === ProposalAction.SetExpiry && (
              <label>
                expiry (ms)
                <input value={u1} onChange={(e) => setU1(e.target.value)} />
              </label>
            )}
            {(action === ProposalAction.AllowlistAdd ||
              action === ProposalAction.AllowlistRemove ||
              action === ProposalAction.BlocklistAdd ||
              action === ProposalAction.BlocklistRemove ||
              action === ProposalAction.SetAddressBook) && (
              <label>
                destination / identity (hex)
                <input value={bytesParam} onChange={(e) => setBytesParam(e.target.value.trim())} />
              </label>
            )}
            {(action === ProposalAction.SetChainEnabled ||
              action === ProposalAction.SetAllowlistEnabled ||
              action === ProposalAction.SetAllowUnverified) && (
              <label className="row">
                <input type="checkbox" checked={boolParam} onChange={(e) => setBoolParam(e.target.checked)} />
                value (on/off)
              </label>
            )}
            <button className="primary" onClick={() => void createProposal()}>
              create proposal
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProposalCard({
  core,
  walletId,
  data,
  proposal,
  isSigner,
  act,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  proposal: AdminProposalState;
  isSigner: boolean;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const exec = useExec();
  const account = useCurrentAccount();
  const voted =
    !!account &&
    (proposal.approvals.includes(account.address) || proposal.rejections.includes(account.address));
  const reached = proposal.thresholdReachedAtMs > 0n;
  const executableAt = reached
    ? Number(proposal.thresholdReachedAtMs + data.state.timelockAdminMs)
    : null;

  return (
    <div className="card request">
      <div className="row spread">
        <strong>
          proposal #{proposal.id.toString()}: {ACTION_LABEL[proposal.action] ?? proposal.action}
          {proposal.addrParam && <span className="mono small"> {proposal.addrParam}</span>}
          {proposal.chainKey && <span className="muted"> [{proposal.chainKey}]</span>}
        </strong>
        <span className="badge">{STATUS_LABEL[proposal.status]}</span>
      </div>
      <div className="small">
        approvals {proposal.approvals.length}/{data.state.adminThreshold.toString()} · rejections{' '}
        {proposal.rejections.length}
        {executableAt && ` · executable after ${new Date(executableAt).toLocaleString()}`}
      </div>
      {isSigner && proposal.status === RequestStatus.Pending && (
        <div className="row">
          {!voted && (
            <>
              <button
                className="primary"
                onClick={() =>
                  act('approve proposal', () =>
                    exec(buildVoteProposalTx(core.ids!, walletId, proposal.id, true), 'vote'),
                  )
                }
              >
                approve
              </button>
              <button
                className="danger"
                onClick={() =>
                  act('veto proposal', () =>
                    exec(buildVoteProposalTx(core.ids!, walletId, proposal.id, false), 'vote'),
                  )
                }
              >
                veto
              </button>
            </>
          )}
          {reached && executableAt && Date.now() >= executableAt && (
            <button
              className="primary"
              onClick={() =>
                act('execute proposal', () =>
                  exec(buildExecuteProposalTx(core.ids!, walletId, proposal.id), 'execute'),
                )
              }
            >
              execute
            </button>
          )}
        </div>
      )}
    </div>
  );
}
