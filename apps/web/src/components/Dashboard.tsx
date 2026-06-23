/**
 * Wallet dashboard: everything reads from chain state via the recovery
 * pipeline, so this page renders identically on any rebuilt frontend.
 */

import { useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { getAddress, Transaction as EthersTransaction } from 'ethers';
import {
  ChainKind,
  ProposalAction,
  RequestStatus,
  type AdminProposalState,
  type ChainBalanceRow,
  type RecoveredWallet,
  type SpendRequestState,
  assembleBtcTransaction,
  assembleEvmTransaction,
  assembleSolTransaction,
  addressToScript,
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
  deriveSolanaAddress,
  curveFromNumber,
  describeUnverifiedPayload,
  evmAddressBytes,
  hexToBytes,
  p2wpkhScript,
  resolveConfig,
  sigAlgFromNumbers,
  solanaAddressBytes,
  utf8,
  buildExecuteProposalTx,
} from '@mythos/wallet-core';
import { BTC_NETWORK_FOR } from '../config';
import { useCreateSpend, useExec, useRecoveredBalances, useRecoveredWallet, type CoreCtx } from '../hooks';

type BalanceState = ReturnType<typeof useRecoveredBalances>;

const DASHBOARD_TABS = ['overview', 'send', 'requests', 'governance', 'addressBook'] as const;
type DashboardTab = (typeof DASHBOARD_TABS)[number];

const TAB_LABEL: Record<DashboardTab, string> = {
  overview: 'overview',
  send: 'send',
  requests: 'requests',
  governance: 'governance',
  addressBook: 'address book',
};

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

function hoursToMs(hours: string): bigint {
  const n = Number.parseFloat(hours.trim());
  if (!Number.isFinite(n) || n < 0) throw new Error('hours must be a non-negative number');
  return BigInt(Math.round(n * 3_600_000));
}

function fmtDuration(ms: bigint): string {
  const hours = Number(ms) / 3_600_000;
  if (!Number.isFinite(hours)) return `${ms.toString()}ms`;
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded.toString()}h`;
}

function balanceKey(row: ChainBalanceRow): string {
  return `${row.assetKind}:${row.assetId}:${row.tokenAccount ?? ''}`;
}

function assetLabel(row: ChainBalanceRow): string {
  const balance = row.amount === null ? 'unknown' : `${fmtUnits(row.amount, row.decimals)} ${row.symbol}`;
  if (row.assetKind === 'native') return `${row.symbol} native - ${balance}`;
  return `${row.symbol} - ${balance}`;
}

function shortAssetId(value: string): string {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizeSuiCoinType(coinType: string): string {
  const parts = coinType.trim().split('::');
  if (parts.length < 3 || !parts[0]) throw new Error('Sui coin type must look like 0x...::module::TYPE');
  return `${normalizeSuiAddress(parts[0])}::${parts.slice(1).join('::')}`;
}

function suiCoinTypeBytes(coinType: string): Uint8Array {
  const normalized = normalizeSuiCoinType(coinType);
  const [addr, ...rest] = normalized.split('::');
  return utf8(`${normalizeSuiAddress(addr).slice(2)}::${rest.join('::')}`);
}

function suiCoinTypeFromBytes(bytes: Uint8Array): string {
  const raw = new TextDecoder().decode(bytes);
  const [addr, ...rest] = raw.split('::');
  if (!addr || rest.length < 2) return raw;
  return `${normalizeSuiAddress(`0x${addr}`)}::${rest.join('::')}`;
}

function fmtChainAmount(chainKey: string, amount: bigint): string {
  const descriptor = chainDescriptor(chainKey);
  const decimals = descriptor?.decimals ?? 0;
  const symbol = descriptor?.symbol ?? 'units';
  return `${fmtUnits(amount, decimals)} ${symbol} (${amount.toString()} base units)`;
}

const STATUS_LABEL: Record<number, string> = {
  [RequestStatus.Pending]: 'pending',
  [RequestStatus.Executed]: 'executed',
  [RequestStatus.Rejected]: 'rejected',
  [RequestStatus.Cancelled]: 'cancelled',
  [RequestStatus.Expired]: 'expired',
};

function presignPoolLabel(key: string): string {
  const [curve, alg] = key.split(':').map((v) => Number(v));
  if (curve === 0 && alg === 0) return 'BTC/EVM secp256k1';
  if (curve === 0 && alg === 1) return 'BTC taproot';
  if (curve === 2 && alg === 0) return 'Solana ed25519';
  return `curve ${curve}, alg ${alg}`;
}

function fmtBalance(row: ChainBalanceRow): string {
  if (row.amount === null) return 'unavailable';
  if (row.confirmedAmount !== undefined) {
    const confirmed = `${fmtUnits(row.confirmedAmount, row.decimals)} ${row.symbol} confirmed`;
    if (row.pendingAmount && row.pendingAmount > 0n) {
      return `${confirmed} + ${fmtUnits(row.pendingAmount, row.decimals)} pending`;
    }
    return confirmed;
  }
  return `${fmtUnits(row.amount, row.decimals)} ${row.symbol}`;
}

function effectiveSpentInWindow(chain: {
  spentInWindow: bigint;
  windowLimit: bigint;
  windowMs: bigint;
  windowStartedAtMs: bigint;
}): bigint {
  if (chain.windowStartedAtMs > 0n && BigInt(Date.now()) >= chain.windowStartedAtMs + chain.windowMs) {
    return 0n;
  }
  return chain.spentInWindow;
}

function effectiveWindowRemaining(chain: {
  spentInWindow: bigint;
  windowLimit: bigint;
  windowMs: bigint;
  windowStartedAtMs: bigint;
}): bigint {
  const spent = effectiveSpentInWindow(chain);
  return chain.windowLimit > spent ? chain.windowLimit - spent : 0n;
}

function sameSuiAddress(a: string, b: string): boolean {
  return normalizeSuiAddress(a) === normalizeSuiAddress(b);
}

function containsSuiAddress(addresses: string[], address: string): boolean {
  return addresses.some((candidate) => sameSuiAddress(candidate, address));
}

function displayChainBytes(data: RecoveredWallet, chainKey: string, bytes: Uint8Array): { value: string; raw: string } {
  const raw = bytesToHex(bytes);
  if (bytes.length === 0) return { value: '(empty)', raw };
  const chain = data.state.chains.get(chainKey);
  if (!chain) return { value: raw, raw };

  if (chain.kind === ChainKind.Evm && bytes.length === 20) {
    try {
      return { value: getAddress(bytesToHex(bytes, true)), raw };
    } catch {
      return { value: raw, raw };
    }
  }

  if (chain.kind === ChainKind.Solana && bytes.length === 32) {
    try {
      return { value: deriveSolanaAddress(bytes), raw };
    } catch {
      return { value: raw, raw };
    }
  }

  if (chain.kind === ChainKind.SuiVault && bytes.length === 32) {
    return { value: normalizeSuiAddress(bytesToHex(bytes, true)), raw };
  }

  if (chain.kind === ChainKind.Btc && bytes[0] === 0 && bytes.length === bytes[1] + 2) {
    const scriptType = bytes[1] === 20 ? 'P2WPKH scriptPubKey' : bytes[1] === 32 ? 'P2WSH scriptPubKey' : 'segwit v0 scriptPubKey';
    return { value: `${scriptType} ${raw}`, raw };
  }

  return { value: raw, raw };
}

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
  const balanceState = useRecoveredBalances(core, data);
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [busyMsg, setBusyMsg] = useState('');

  if (error) return <main className="card error">{error}</main>;
  if (!data)
    return (
      <main className="card">
        <div className="skeleton h-18 w-60" />
        <div className="skeleton w-80" />
        <div className="skeleton w-40" />
        <p className="muted" style={{ marginTop: 12 }}>Recovering wallet state from chain...</p>
      </main>
    );

  const isSigner = !!account && containsSuiAddress(data.state.signers, account.address);

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
        {DASHBOARD_TABS.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
            {t === 'requests' && data.pendingRequests.length > 0 && (
              <span className="badge">{data.pendingRequests.length}</span>
            )}
            {t === 'governance' && data.pendingProposals.length > 0 && (
              <span className="badge">{data.pendingProposals.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview core={core} walletId={walletId} data={data} balances={balanceState} act={act} />}
      {tab === 'send' && (
        <SendTab
          core={core}
          walletId={walletId}
          data={data}
          balances={balanceState}
          isSigner={isSigner}
          onSubmitted={refresh}
        />
      )}
      {tab === 'requests' && (
        <RequestsTab core={core} walletId={walletId} data={data} isSigner={isSigner} act={act} />
      )}
      {tab === 'governance' && (
        <GovernanceTab core={core} walletId={walletId} data={data} isSigner={isSigner} act={act} />
      )}
      {tab === 'addressBook' && <AddressBookTab data={data} />}
    </main>
  );
}

// === Overview ===

function Overview({
  core,
  walletId,
  data,
  balances,
  act,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  balances: BalanceState;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const exec = useExec();
  const [vaultCoinType, setVaultCoinType] = useState('0x2::sui::SUI');
  const [vaultAmount, setVaultAmount] = useState('1');
  const [vaultDecimals, setVaultDecimals] = useState('9');

  async function depositVaultCoin() {
    if (!core.ids) throw new Error('contract ids not ready');
    const decimals = Number.parseInt(vaultDecimals, 10);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error('decimals must be an integer between 0 and 18');
    }
    const coinType = normalizeSuiCoinType(vaultCoinType);
    const amount = toBase(vaultAmount, decimals);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    await exec(buildVaultDepositTx(core.ids, walletId, coinType, amount), 'vault deposit');
    await balances.refresh();
  }

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
          spend timelock {fmtDuration(data.state.timelockSpendMs)} · admin timelock{' '}
          {fmtDuration(data.state.timelockAdminMs)} · request expiry{' '}
          {fmtDuration(data.state.requestExpiryMs)}
        </p>
      </div>

      <div className="card">
        <h3>Addresses (re-derived from Ika dWallet public keys)</h3>
        <table>
          <tbody>
            {data.addresses.map((a) => (
              <tr key={a.chainKey}>
                <td>{a.chainKey}</td>
                <td className="mono">
                  {a.address || '(dWallet pending)'}
                  {a.kind === ChainKind.SuiVault && (
                    <span className="badge danger vault-address-flag">
                      DO NOT SEND DIRECTLY TO THIS ADDRESS. USE DEPOSIT TO VAULT FUNCTION BELOW.
                    </span>
                  )}
                </td>
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
        <div className="row spread">
          <h3>Balances</h3>
          <button onClick={() => void balances.refresh()} disabled={balances.loading}>
            {balances.loading ? 'refreshing...' : 'refresh balances'}
          </button>
        </div>
        {balances.error && <div className="error small">{balances.error}</div>}
        {!balances.balances && !balances.error && <p className="muted">Loading target-chain balances...</p>}
        {balances.balances && (
          <table>
            <thead>
              <tr>
                <th>chain</th><th>asset</th><th>balance</th><th>status</th>
              </tr>
            </thead>
            <tbody>
              {balances.balances.map((row) => (
                <tr key={`${row.chainKey}:${balanceKey(row)}`}>
                  <td>{row.chainKey}</td>
                  <td>
                    {row.assetId ? row.label : chainDescriptor(row.chainKey)?.symbol ?? row.symbol}
                    {row.assetId && <div className="mono small muted">{row.assetId}</div>}
                  </td>
                  <td>{fmtBalance(row)}</td>
                  <td className={row.status === 'ok' ? 'ok' : row.status === 'error' ? 'error' : 'muted'}>
                    {row.status === 'ok' ? row.source : row.error ?? row.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Target-chain balances are live RPC reads. Fee reserves below are separate Sui-held IKA/SUI used for Ika operations.
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
              const spent = effectiveSpentInWindow(c);
              const reset = spent === 0n && c.spentInWindow > 0n;
              return (
                <tr key={c.chainKey} className={c.enabled ? '' : 'disabled'}>
                  <td>{c.chainKey}</td>
                  <td>{fmtUnits(c.perTxLimit, dec)}</td>
                  <td>{fmtUnits(c.fastPathLimit, dec)}</td>
                  <td>
                    {fmtUnits(c.windowLimit, dec)} / {fmtDuration(c.windowMs)}
                  </td>
                  <td>
                    {fmtUnits(spent, dec)}{reset && <span className="muted"> (reset)</span>}
                  </td>
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
            .map(([k, v]) => `${presignPoolLabel(k)}: ${v.length}`)
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
          </div>
        )}
        {core.ids && (
          <div className="vault-deposit form">
            <h4>Deposit to Sui Vault</h4>
            <p className="muted small">
              This calls `vault_deposit&lt;T&gt;`. Do not direct-send Sui coins to the wallet object ID.
            </p>
            <label>
              Coin type
              <input value={vaultCoinType} onChange={(e) => setVaultCoinType(e.target.value.trim())} />
            </label>
            <div className="row wrap">
              <label>
                Amount
                <input value={vaultAmount} onChange={(e) => setVaultAmount(e.target.value.trim())} />
              </label>
              <label>
                Decimals
                <input value={vaultDecimals} onChange={(e) => setVaultDecimals(e.target.value.trim())} />
              </label>
              <button onClick={() => act('vault deposit', depositVaultCoin)}>deposit to vault</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// === Address Book ===

function AddressBookTab({ data }: { data: RecoveredWallet }) {
  const chains = [...data.state.chains.values()].sort((a, b) => a.chainKey.localeCompare(b.chainKey));
  const identityKeys = [...new Set([...chains.map((c) => c.chainKey), ...data.state.addressBook.keys()])].sort();

  return (
    <section className="address-book">
      <div className="card">
        <h3>Recorded chain identities</h3>
        <table>
          <thead>
            <tr>
              <th>chain</th><th>recorded identity</th><th>raw bytes</th><th>derived address</th><th>status</th>
            </tr>
          </thead>
          <tbody>
            {identityKeys.map((chainKey) => {
              const recorded = data.state.addressBook.get(chainKey) ?? null;
              const derived = data.addresses.find((a) => a.chainKey === chainKey);
              const display = recorded ? displayChainBytes(data, chainKey, recorded) : null;
              return (
                <tr key={chainKey}>
                  <td>
                    {chainDescriptor(chainKey)?.displayName ?? chainKey}
                    <div className="muted">{chainKey}</div>
                  </td>
                  <td className="mono break">{display?.value ?? '(none recorded)'}</td>
                  <td className="mono break muted">{display?.raw ?? ''}</td>
                  <td className="mono break">{derived?.address || '(not derived)'}</td>
                  <td>
                    {derived?.verified ? (
                      <span className="badge ok">verified</span>
                    ) : recorded ? (
                      <span className="badge danger">mismatch</span>
                    ) : (
                      <span className="badge warn">missing</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">
          Recorded identities are on-chain policy bytes. Verified means the recorded bytes match the address this client re-derived from the Ika dWallet public key.
        </p>
      </div>

      {chains.map((chain) => (
        <div className="card address-chain" data-chain={chain.chainKey} key={chain.chainKey}>
          <div className="row spread wrap">
            <h3>{chainDescriptor(chain.chainKey)?.displayName ?? chain.chainKey}</h3>
            <div>
              <span className={`badge ${chain.enabled ? 'ok' : 'danger'}`}>{chain.enabled ? 'enabled' : 'disabled'}</span>
              <span className={`badge ${chain.allowlistEnabled ? 'warn' : ''}`}>
                {chain.allowlistEnabled ? 'allowlist enforced' : 'allowlist off'}
              </span>
              {chain.allowUnverified && <span className="badge warn">unverified allowed</span>}
            </div>
          </div>
          <p className="muted">Blocklist entries always deny matching destinations. Allowlist entries only gate spends while allowlist enforcement is on.</p>
          <div className="address-lists">
            <AddressBytesTable title="Allowlist" chainKey={chain.chainKey} entries={chain.allowlist} data={data} />
            <AddressBytesTable title="Blocklist" chainKey={chain.chainKey} entries={chain.blocklist} data={data} />
          </div>
        </div>
      ))}
    </section>
  );
}

function AddressBytesTable({
  title,
  chainKey,
  entries,
  data,
}: {
  title: string;
  chainKey: string;
  entries: string[];
  data: RecoveredWallet;
}) {
  return (
    <div className="address-list">
      <strong>{title}</strong>
      {entries.length === 0 ? (
        <p className="muted">No entries.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>destination</th><th>raw bytes</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((rawHex) => {
              let display = { value: rawHex, raw: rawHex };
              try {
                display = displayChainBytes(data, chainKey, hexToBytes(rawHex));
              } catch {
                display = { value: rawHex, raw: rawHex };
              }
              return (
                <tr key={rawHex}>
                  <td className="mono break">{display.value}</td>
                  <td className="mono break muted">{display.raw}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// === Send ===

function SendTab({
  core,
  walletId,
  data,
  balances,
  isSigner,
  onSubmitted,
}: {
  core: CoreCtx;
  walletId: string;
  data: RecoveredWallet;
  balances: BalanceState;
  isSigner: boolean;
  onSubmitted: () => Promise<void>;
}) {
  const exec = useExec();
  const { createSpend, busy, status } = useCreateSpend(core);
  const chains = [...data.state.chains.values()].filter((c) => c.enabled);
  const [chainKey, setChainKey] = useState(chains[0]?.chainKey ?? '');
  const [assetKey, setAssetKey] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const chain = data.state.chains.get(chainKey);
  const assetOptions = (balances.balances ?? []).filter(
    (row) => row.chainKey === chainKey && row.status === 'ok' && row.amount !== null,
  );
  const selectedAsset = assetOptions.find((row) => balanceKey(row) === assetKey) ?? assetOptions[0] ?? null;
  const selectedDecimals = selectedAsset?.decimals ?? chainDescriptor(chainKey)?.decimals ?? 9;
  const selectedSymbol = selectedAsset?.symbol ?? chainDescriptor(chainKey)?.symbol ?? 'units';
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
      if (!selectedAsset) throw new Error('select an asset with a loaded balance');
      const amountBase = toBase(amount, selectedAsset.decimals);
      if (selectedAsset.amount !== null && amountBase > selectedAsset.amount) {
        throw new Error(`insufficient ${selectedAsset.symbol}: balance is ${fmtUnits(selectedAsset.amount, selectedAsset.decimals)}`);
      }
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
        const coinType = normalizeSuiCoinType(selectedAsset.assetId);
        const tx = buildCreateVaultSpendRequestTx(core.ids, walletId, {
          chainKey: utf8(chainKey),
          coinTypeBytes: suiCoinTypeBytes(coinType),
          destination: hexToBytes(destination),
          amount: amountBase,
        });
        await exec(tx, 'vault spend request');
      } else {
        await createSpend(walletId, data, {
          chainKey,
          destination,
          amountBaseUnits: amountBase,
          tokenAddress: selectedAsset.assetKind === 'token' ? selectedAsset.assetId : undefined,
          tokenDecimals: selectedAsset.assetKind === 'token' ? selectedAsset.decimals : undefined,
          solanaSourceTokenAccount: selectedAsset.tokenAccount,
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
    <section className="card chain-surface" data-chain={chainKey || undefined}>
      <div className="chain-header">
        <h3>New spend request</h3>
        <span className="chain-chip">
          <span className="chain-swatch" />
          {chainDescriptor(chainKey)?.displayName ?? (chainKey || 'select chain')}
        </span>
      </div>
      <div className="send-layout">
        <div className="form">
          <label>
            Chain
            <select
              value={chainKey}
              onChange={(e) => {
                setChainKey(e.target.value);
                setAssetKey('');
              }}
            >
              {chains.map((c) => (
                <option key={c.chainKey} value={c.chainKey}>
                  {chainDescriptor(c.chainKey)?.displayName ?? c.chainKey}
                </option>
              ))}
            </select>
          </label>
          <label>
            Asset
            <select value={selectedAsset ? balanceKey(selectedAsset) : ''} onChange={(e) => setAssetKey(e.target.value)}>
              {assetOptions.length === 0 && <option value="">{balances.loading ? 'loading balances...' : 'no spendable balance found'}</option>}
              {assetOptions.map((row) => (
                <option key={balanceKey(row)} value={balanceKey(row)}>
                  {assetLabel(row)}
                </option>
              ))}
            </select>
          </label>
          {selectedAsset && (
            <p className="muted small">
              Available: {fmtUnits(selectedAsset.amount ?? 0n, selectedAsset.decimals)} {selectedAsset.symbol}
              {selectedAsset.assetId && <span className="mono"> · {selectedAsset.assetId}</span>}
            </p>
          )}
          <label>
            Destination {destinationHint}
            <input
              className="destination-glow"
              value={destination}
              onChange={(e) => setDestination(e.target.value.trim())}
            />
          </label>
          <label>
            Amount ({selectedSymbol})
            <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
          </label>
          {chain && (
            <p className="muted">
              policy: per-tx max {fmtUnits(chain.perTxLimit, selectedDecimals)} · fast path&nbsp;
              {fmtUnits(chain.fastPathLimit, selectedDecimals)} (1 approval, no timelock) · window&nbsp;
              {fmtUnits(effectiveWindowRemaining(chain), selectedDecimals)} remaining
            </p>
          )}
          {status && <div className="progress-line">{status}</div>}
          {err && <div className="error">{err}</div>}
          <button className="primary" onClick={() => void submit()} disabled={busy || !destination || !amount || !selectedAsset}>
            {busy ? 'preparing...' : 'create spend request'}
          </button>
        </div>
        <div className="coin-stage" aria-hidden="true">
          <ChainCoin chainKey={chainKey} />
        </div>
      </div>
    </section>
  );
}

function ChainCoin({ chainKey }: { chainKey: string }) {
  const family = chainKey.startsWith('btc:')
    ? 'btc'
    : chainKey.startsWith('solana:')
      ? 'sol'
      : chainKey.startsWith('sui:')
        ? 'sui'
        : chainKey.startsWith('eip155:')
          ? 'eth'
          : null;
  if (!family) {
    return (
      <div className="coin" aria-hidden="true">
        <div className="coin-unknown">?</div>
      </div>
    );
  }
  return (
    <div className="coin" data-chain={chainKey || undefined} aria-hidden="true">
      <img className="coin-svg" src={`/coins/${family}-coin.svg`} alt="" />
    </div>
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
      const coinType = suiCoinTypeFromBytes(req.asset);
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
  const suiCoinType = chain?.kind === ChainKind.SuiVault ? suiCoinTypeFromBytes(req.asset) : '';
  const tokenRequest = !!chain && chain.kind !== ChainKind.SuiVault && req.asset.length > 0;
  const requestSymbol = suiCoinType
    ? (suiCoinType.split('::').at(-1) ?? 'coin')
    : tokenRequest
      ? (chain.kind === ChainKind.Solana ? `SPL ${shortAssetId(bytesToHex(req.asset))}` : 'token base units')
    : chainDescriptor(req.chainKey)?.symbol;
  const dec = suiCoinType ? (suiCoinType === '0x2::sui::SUI' ? 9 : 0) : tokenRequest ? 0 : (chainDescriptor(req.chainKey)?.decimals ?? 9);
  const destinationDisplay = chain ? displayChainBytes(data, req.chainKey, req.destination).value : bytesToHex(req.destination);
  const alreadyVoted =
    !!account &&
    (containsSuiAddress(req.approvals, account.address) ||
      containsSuiAddress(req.rejections, account.address));

  // independent client-side verification before voting (mirrors Move)
  const intentCheck = useMemo(() => {
    if (!chain) return { ok: false, errors: ['unknown chain'], summary: '' };
    try {
      if (chain.kind === ChainKind.SuiVault) {
        return {
          ok: true,
          errors: [],
          summary: `Vault transfer of ${fmtUnits(req.amount, dec)} ${requestSymbol ?? 'coin'} to ${destinationDisplay}${suiCoinType ? ` (${suiCoinType})` : ''}`,
        };
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
          asset: req.asset,
          destination: req.destination,
          amount: req.amount,
        });
      }
      return { ok: false, errors: ['unsupported kind'], summary: '' };
    } catch (e) {
      return { ok: false, errors: [(e as Error).message], summary: '' };
    }
  }, [chain, data, dec, destinationDisplay, req, requestSymbol, suiCoinType]);

  const required = Number(data.state.threshold);
  const reached = req.thresholdReachedAtMs > 0n;
  const executableAt = reached ? Number(req.thresholdReachedAtMs + data.state.timelockSpendMs) : null;
  const executableNow = !!executableAt && Date.now() >= executableAt;
  const remainingMs = executableAt ? BigInt(Math.max(0, executableAt - Date.now())) : 0n;
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
    <div className="card request" data-chain={req.chainKey}>
      <div className="row spread">
        <strong>
          #{req.id.toString()} {req.chainKey} · {fmtUnits(req.amount, dec)}{' '}
          {requestSymbol}
          <span className="badge chain">{chainDescriptor(req.chainKey)?.displayName ?? req.chainKey}</span>
        </strong>
        <span className={`badge ${req.status === 0 ? '' : 'ok'}`}>{STATUS_LABEL[req.status]}</span>
      </div>
      <div className="mono small">to {destinationDisplay}</div>
      {suiCoinType && <div className="mono small muted">coin {suiCoinType}</div>}
      {tokenRequest && <div className="mono small muted">asset {bytesToHex(req.asset)}</div>}
      {decoded && <div className="muted small">{decoded}</div>}
      <div className={intentCheck.ok ? 'ok small' : 'error small'}>
        {intentCheck.ok ? `verified: ${intentCheck.summary}` : `CHECK FAILED: ${intentCheck.errors.join('; ')}`}
      </div>
      <div className="small">
        approvals {req.approvals.length}/{required} · rejections {req.rejections.length} ·{' '}
        {reached ? 'threshold reached' : 'collecting votes'} · creator {req.creator.slice(0, 8)}...
      </div>
      <p className="muted small">
        Spend timelock: {fmtDuration(data.state.timelockSpendMs)}.{' '}
        {reached && executableAt
          ? `Executable after ${new Date(executableAt).toLocaleString()}${executableNow ? '' : ` (${fmtDuration(remainingMs)} remaining)`}.`
          : 'Starts after the spend threshold is reached.'}
      </p>
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
          {reached && !executableNow && executableAt && (
            <span className="muted small">Waiting on spend timelock until {new Date(executableAt).toLocaleString()}.</span>
          )}
          {reached && executableNow && (
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

const CREATE_PROPOSAL_ACTIONS = [
  ProposalAction.AddSigner,
  ProposalAction.RemoveSigner,
  ProposalAction.SetThresholds,
  ProposalAction.SetTimelocks,
  ProposalAction.SetExpiry,
  ProposalAction.SetChainLimits,
  ProposalAction.AllowlistAdd,
  ProposalAction.AllowlistRemove,
  ProposalAction.BlocklistAdd,
  ProposalAction.BlocklistRemove,
  ProposalAction.Unpause,
  ProposalAction.SetAddressBook,
  ProposalAction.SetChainEnabled,
  ProposalAction.SetAllowlistEnabled,
  ProposalAction.SetAllowUnverified,
] as const;

type DetailRow = { label: string; value: string; mono?: boolean };

function proposalUParam(proposal: AdminProposalState, index: number): bigint | null {
  return index < proposal.uParams.length ? proposal.uParams[index] : null;
}

function fmtMaybe(value: bigint | null, fmt: (value: bigint) => string): string {
  return value === null ? '(missing)' : fmt(value);
}

function proposalBytesRows(
  data: RecoveredWallet,
  proposal: AdminProposalState,
  label: string,
): DetailRow[] {
  const display = displayChainBytes(data, proposal.chainKey, proposal.bytesParam);
  const rows: DetailRow[] = [{ label, value: display.value, mono: true }];
  if (display.raw && display.raw !== display.value) rows.push({ label: 'raw bytes', value: display.raw, mono: true });
  return rows;
}

function proposalDetailRows(data: RecoveredWallet, proposal: AdminProposalState): DetailRow[] {
  const rows: DetailRow[] = [];
  if (proposal.chainKey) {
    const name = chainDescriptor(proposal.chainKey)?.displayName ?? proposal.chainKey;
    rows.push({ label: 'chain', value: `${name} (${proposal.chainKey})` });
  }

  switch (proposal.action) {
    case ProposalAction.AddSigner:
      rows.push({ label: 'new signer', value: proposal.addrParam ?? '(missing)', mono: true });
      break;
    case ProposalAction.RemoveSigner:
      rows.push({ label: 'remove signer', value: proposal.addrParam ?? '(missing)', mono: true });
      break;
    case ProposalAction.SetThresholds:
      rows.push(
        { label: 'spend threshold', value: fmtMaybe(proposalUParam(proposal, 0), (v) => v.toString()) },
        { label: 'admin threshold', value: fmtMaybe(proposalUParam(proposal, 1), (v) => v.toString()) },
      );
      break;
    case ProposalAction.SetTimelocks:
      rows.push(
        { label: 'spend timelock', value: fmtMaybe(proposalUParam(proposal, 0), fmtDuration) },
        { label: 'admin timelock', value: fmtMaybe(proposalUParam(proposal, 1), fmtDuration) },
      );
      break;
    case ProposalAction.SetExpiry:
      rows.push({ label: 'request expiry', value: fmtMaybe(proposalUParam(proposal, 0), fmtDuration) });
      break;
    case ProposalAction.SetChainLimits:
      rows.push(
        { label: 'fast path', value: fmtMaybe(proposalUParam(proposal, 0), (v) => fmtChainAmount(proposal.chainKey, v)) },
        { label: 'per-tx limit', value: fmtMaybe(proposalUParam(proposal, 1), (v) => fmtChainAmount(proposal.chainKey, v)) },
        { label: 'window limit', value: fmtMaybe(proposalUParam(proposal, 2), (v) => fmtChainAmount(proposal.chainKey, v)) },
        { label: 'window length', value: fmtMaybe(proposalUParam(proposal, 3), fmtDuration) },
        { label: 'fee cap', value: fmtMaybe(proposalUParam(proposal, 4), (v) => fmtChainAmount(proposal.chainKey, v)) },
      );
      break;
    case ProposalAction.AllowlistAdd:
      rows.push(...proposalBytesRows(data, proposal, 'allowlist add'));
      break;
    case ProposalAction.AllowlistRemove:
      rows.push(...proposalBytesRows(data, proposal, 'allowlist remove'));
      break;
    case ProposalAction.BlocklistAdd:
      rows.push(...proposalBytesRows(data, proposal, 'blocklist add'));
      break;
    case ProposalAction.BlocklistRemove:
      rows.push(...proposalBytesRows(data, proposal, 'blocklist remove'));
      break;
    case ProposalAction.Unpause:
      rows.push({ label: 'effect', value: 'unpause wallet' });
      break;
    case ProposalAction.SetAddressBook:
      rows.push(...proposalBytesRows(data, proposal, 'record identity'));
      break;
    case ProposalAction.SetChainEnabled:
      rows.push({ label: 'chain enabled', value: proposal.boolParam ? 'on' : 'off' });
      break;
    case ProposalAction.SetAllowlistEnabled:
      rows.push({ label: 'allowlist enforcement', value: proposal.boolParam ? 'on' : 'off' });
      break;
    case ProposalAction.SetAllowUnverified:
      rows.push({ label: 'unverified payloads', value: proposal.boolParam ? 'allowed' : 'blocked' });
      break;
    default:
      rows.push(
        { label: 'bytes', value: bytesToHex(proposal.bytesParam), mono: true },
        { label: 'u params', value: proposal.uParams.map((v) => v.toString()).join(', ') || '(none)' },
        { label: 'bool', value: proposal.boolParam ? 'true' : 'false' },
      );
  }

  return rows;
}

function isChainProposal(action: number): boolean {
  return action >= ProposalAction.SetChainLimits && action !== ProposalAction.Unpause;
}

function isDestinationBytesProposal(action: number): boolean {
  return (
    action === ProposalAction.AllowlistAdd ||
    action === ProposalAction.AllowlistRemove ||
    action === ProposalAction.BlocklistAdd ||
    action === ProposalAction.BlocklistRemove ||
    action === ProposalAction.SetAddressBook
  );
}

function parseChainBytesParam({
  value,
  chainKey,
  data,
  core,
}: {
  value: string;
  chainKey: string;
  data: RecoveredWallet;
  core: CoreCtx;
}): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('destination / identity is required');
  const chain = data.state.chains.get(chainKey);
  if (!chain) throw new Error('select a chain');
  if (chain.kind === ChainKind.Btc) return addressToScript(trimmed, BTC_NETWORK_FOR[core.network]);
  if (chain.kind === ChainKind.Evm) return evmAddressBytes(trimmed);
  if (chain.kind === ChainKind.Solana) return solanaAddressBytes(trimmed);
  return hexToBytes(trimmed);
}

function bytesParamLabel(action: number, chainKey: string): string {
  if (action === ProposalAction.SetAddressBook) return 'address book identity (chain-native)';
  const descriptor = chainDescriptor(chainKey);
  const name = descriptor?.displayName ?? 'chain';
  if (
    action === ProposalAction.AllowlistAdd ||
    action === ProposalAction.AllowlistRemove ||
    action === ProposalAction.BlocklistAdd ||
    action === ProposalAction.BlocklistRemove
  ) {
    return `${name} destination (chain-native)`;
  }
  return 'destination / identity';
}

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
  const [u3, setU3] = useState('');
  const [u4, setU4] = useState('');
  const [u5, setU5] = useState('');
  const [boolParam, setBoolParam] = useState(true);
  const [bytesParam, setBytesParam] = useState('');
  const [proposalErr, setProposalErr] = useState<string | null>(null);

  const selectedChain = chainKey ? data.state.chains.get(chainKey) : null;
  const selectedDecimals = chainDescriptor(chainKey)?.decimals ?? 0;

  async function createProposal() {
    setProposalErr(null);
    try {
      if (!core.ids) throw new Error('deployment not configured');
      if (isChainProposal(action) && !chainKey) throw new Error('select a chain');
      const uParams: bigint[] = [];
      if (action === ProposalAction.SetThresholds) {
        uParams.push(BigInt(u1 || '0'), BigInt(u2 || '0'));
      } else if (action === ProposalAction.SetTimelocks) {
        uParams.push(hoursToMs(u1 || '0'), hoursToMs(u2 || '0'));
      } else if (action === ProposalAction.SetExpiry) {
        uParams.push(hoursToMs(u1 || '0'));
      } else if (action === ProposalAction.SetChainLimits) {
        if (!selectedChain) throw new Error('select a chain');
        uParams.push(
          toBase(u1 || '0', selectedDecimals),
          toBase(u2 || '0', selectedDecimals),
          toBase(u3 || '0', selectedDecimals),
          hoursToMs(u4 || '0'),
          toBase(u5 || '0', selectedDecimals),
        );
      }
      const needsAddr = action === ProposalAction.AddSigner || action === ProposalAction.RemoveSigner;
      const needsBytes = isDestinationBytesProposal(action);
      const tx = buildCreateProposalTx(core.ids, walletId, {
        action,
        chainKey: chainKey ? utf8(chainKey) : new Uint8Array(),
        addrParam: needsAddr ? addrParam : null,
        bytesParam: needsBytes ? parseChainBytesParam({ value: bytesParam, chainKey, data, core }) : new Uint8Array(),
        uParams,
        boolParam,
      });
      await act('create proposal', () => exec(tx, 'create_proposal'));
    } catch (e) {
      setProposalErr((e as Error).message);
    }
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
            {fmtDuration(data.state.timelockAdminMs)} (veto window) before execution. Execution uses the wallet's current admin timelock, so changing it can move already-approved pending proposals earlier or later.
          </p>
          <div className="form">
            <label>
              Action
              <select value={action} onChange={(e) => setAction(parseInt(e.target.value))}>
                {CREATE_PROPOSAL_ACTIONS.map((v) => (
                  <option key={v} value={v}>
                    {ACTION_LABEL[v]}
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
            {isChainProposal(action) && (
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
                  {action === ProposalAction.SetThresholds ? 'spend threshold' : 'spend timelock (hours)'}
                  <input value={u1} onChange={(e) => setU1(e.target.value)} />
                </label>
                <label>
                  {action === ProposalAction.SetThresholds ? 'admin threshold' : 'admin timelock (hours)'}
                  <input value={u2} onChange={(e) => setU2(e.target.value)} />
                </label>
              </div>
            )}
            {action === ProposalAction.SetExpiry && (
              <label>
                request expiry (hours)
                <input value={u1} onChange={(e) => setU1(e.target.value)} />
              </label>
            )}
            {action === ProposalAction.SetChainLimits && (
              <>
                <div className="row wrap">
                  <label>
                    fast path ({chainDescriptor(chainKey)?.symbol ?? 'units'})
                    <input value={u1} onChange={(e) => setU1(e.target.value)} />
                  </label>
                  <label>
                    per-tx limit ({chainDescriptor(chainKey)?.symbol ?? 'units'})
                    <input value={u2} onChange={(e) => setU2(e.target.value)} />
                  </label>
                  <label>
                    window limit ({chainDescriptor(chainKey)?.symbol ?? 'units'})
                    <input value={u3} onChange={(e) => setU3(e.target.value)} />
                  </label>
                </div>
                <div className="row wrap">
                  <label>
                    window length (hours)
                    <input value={u4} onChange={(e) => setU4(e.target.value)} />
                  </label>
                  <label>
                    fee cap ({chainDescriptor(chainKey)?.symbol ?? 'units'})
                    <input value={u5} onChange={(e) => setU5(e.target.value)} />
                  </label>
                </div>
              </>
            )}
            {isDestinationBytesProposal(action) && (
              <label>
                {bytesParamLabel(action, chainKey)}
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
            {proposalErr && <div className="error small">{proposalErr}</div>}
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
    (containsSuiAddress(proposal.approvals, account.address) ||
      containsSuiAddress(proposal.rejections, account.address));
  const reached = proposal.thresholdReachedAtMs > 0n;
  const executableAt = reached
    ? Number(proposal.thresholdReachedAtMs + data.state.timelockAdminMs)
    : null;
  const executableNow = !!executableAt && Date.now() >= executableAt;
  const needed = Math.max(0, Number(data.state.adminThreshold) - proposal.approvals.length);
  const detailRows = proposalDetailRows(data, proposal);

  return (
    <div className="card request" data-chain={proposal.chainKey || undefined}>
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
      {detailRows.length > 0 && (
        <div className="proposal-details">
          {detailRows.map((row, index) => (
            <div className="detail-row" key={`${row.label}:${index}`}>
              <span className="muted">{row.label}</span>
              <span className={`${row.mono ? 'mono ' : ''}small break`}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
      {reached && executableAt && (
        <p className="muted small">
          Uses current admin timelock ({fmtDuration(data.state.timelockAdminMs)}) from the threshold time; future timelock changes can move this execution date.
        </p>
      )}
      {proposal.status === RequestStatus.Pending && (
        <div className="row wrap">
          {!isSigner && <span className="muted small">Connect as a wallet signer to vote.</span>}
          {isSigner && voted && <span className="muted small">You already voted on this proposal.</span>}
          {isSigner && !voted && (
            <>
              <button
                className="primary"
                disabled={!core.ids}
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
                disabled={!core.ids}
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
          {!reached && <span className="muted small">Needs {needed} more approval{needed === 1 ? '' : 's'}.</span>}
          {reached && executableAt && !executableNow && (
            <span className="muted small">Executable after {new Date(executableAt).toLocaleString()}.</span>
          )}
          {isSigner && reached && executableNow && (
            <button
              className="primary"
              disabled={!core.ids}
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
