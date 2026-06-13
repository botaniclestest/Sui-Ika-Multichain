/**
 * Wallet creation wizard.
 *
 * Step 1 - signer set, thresholds, timelocks, expiry
 * Step 2 - chains and limits
 * Step 3 - review and execute:
 *          a. DKG preparation in-browser (shared mode, nothing to store)
 *          b. create_wallet PTB (contract performs DKG, keeps the cap)
 *          c. wait for the dWallet to activate, derive chain addresses
 *          d. configure chains + record address book + finalize (one PTB)
 *          e. fund fee balances + first presigns
 */

import { useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import {
  ChainKind,
  Curve,
  IkaCurve,
  KNOWN_CHAINS,
  buildAddPresignTx,
  buildConfigureChainTx,
  buildCreateWalletTx,
  buildDepositBalancesTx,
  buildFinalizeSetupTx,
  buildRecordAddressTx,
  deriveBtcAddress,
  deriveEvmAddress,
  deriveSolanaAddress,
  evmAddressBytes,
  getWalletState,
  p2wpkhScript,
  utf8,
  type ChainDescriptor,
} from '@mythos/wallet-core';
import { BTC_NETWORK_FOR } from '../config';
import { useExec, type CoreCtx } from '../hooks';

interface ChainDraft {
  enabled: boolean;
  fastPath: string; // human units
  perTx: string;
  window: string;
  windowHours: string;
  feeLimit: string;
  allowlistEnabled: boolean;
  allowUnverified: boolean;
}

const DEFAULT_DRAFT: ChainDraft = {
  enabled: false,
  fastPath: '0',
  perTx: '0.1',
  window: '0.5',
  windowHours: '24',
  feeLimit: '0.001',
  allowlistEnabled: false,
  allowUnverified: false,
};

function toBase(human: string, decimals: number): bigint {
  const [whole, frac = ''] = human.trim().split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

export function CreateWizard({
  core,
  onDone,
  onCancel,
}: {
  core: CoreCtx;
  onDone: (walletId: string) => void;
  onCancel: () => void;
}) {
  const account = useCurrentAccount();
  const exec = useExec();
  const [step, setStep] = useState(1);

  // step 1 state
  const [signers, setSigners] = useState<string[]>(account ? [account.address] : ['']);
  const [threshold, setThreshold] = useState(2);
  const [adminThreshold, setAdminThreshold] = useState(2);
  const [timelockSpendH, setTimelockSpendH] = useState('1');
  const [timelockAdminH, setTimelockAdminH] = useState('24');
  const [expiryH, setExpiryH] = useState('72');

  // step 2 state
  const relevantChains = useMemo(
    () =>
      KNOWN_CHAINS.filter((c) => {
        if (core.network === 'mainnet') {
          return !['btc:testnet', 'eip155:11155111', 'eip155:84532', 'solana:devnet'].includes(c.chainKey);
        }
        return ['btc:testnet', 'eip155:11155111', 'eip155:84532', 'solana:devnet', 'sui:vault'].includes(c.chainKey);
      }),
    [core.network],
  );
  const [chainDrafts, setChainDrafts] = useState<Record<string, ChainDraft>>(() =>
    Object.fromEntries(relevantChains.map((c) => [c.chainKey, { ...DEFAULT_DRAFT }])),
  );

  // step 3 state
  const [progress, setProgress] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const log = (m: string) => setProgress((p) => [...p, m]);

  const validSigners = signers.filter((s) => s.startsWith('0x') && s.length === 66);
  const enabledChains = relevantChains.filter((c) => chainDrafts[c.chainKey]?.enabled);
  const needsEd25519 = enabledChains.some((c) => c.kind === ChainKind.Solana);

  async function run() {
    if (!core.ids || !account) return;
    setRunning(true);
    setError(null);
    try {
      // a. DKG prep
      log('Preparing DKG (in-browser, shared mode - nothing will need backup)...');
      const dkg = await core.ika.prepareSharedDkg(Curve.SECP256K1, account.address);
      const nekId = await core.ika.latestNetworkEncryptionKeyId();

      // b. create wallet
      log('Creating wallet on Sui (contract runs the DKG and keeps the cap)...');
      const createTx = buildCreateWalletTx(core.ids, {
        signers: validSigners,
        threshold: BigInt(threshold),
        adminThreshold: BigInt(adminThreshold),
        timelockSpendMs: BigInt(Math.round(parseFloat(timelockSpendH) * 3_600_000)),
        timelockAdminMs: BigInt(Math.round(parseFloat(timelockAdminH) * 3_600_000)),
        requestExpiryMs: BigInt(Math.round(parseFloat(expiryH) * 3_600_000)),
        networkEncryptionKeyId: nekId,
        centralizedPublicKeyShareAndProof: dkg.centralizedPublicKeyShareAndProof,
        userPublicOutput: dkg.userPublicOutput,
        publicUserSecretKeyShare: dkg.publicUserSecretKeyShare,
        sessionIdentifier: dkg.sessionIdentifier,
        ikaBudget: 1_500_000_000n,
        suiBudget: 1_000_000_000n,
      });
      const { discoverWallets } = await import('@mythos/wallet-core');
      const before = new Set(
        await discoverWallets(core.sui as never, core.ids.typesPackageId ?? core.ids.packageId, core.ids.registryId, account.address),
      );
      await exec(createTx, 'create_wallet');
      // The new wallet registers itself in the on-chain registry; find it there.
      let walletId: string | null = null;
      for (let i = 0; i < 20 && !walletId; i++) {
        const after = await discoverWallets(
          core.sui as never, core.ids.typesPackageId ?? core.ids.packageId, core.ids.registryId, account.address,
        );
        walletId = after.find((id) => !before.has(id)) ?? null;
        if (!walletId) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!walletId) throw new Error('new wallet not found in registry');
      log(`Wallet: ${walletId}`);

      // optional second dWallet for Solana - failure here must NOT abort
      // the whole wallet creation; we just continue without Solana.
      let solanaEnabled = false;
      if (needsEd25519) {
        try {
          log('Solana enabled: creating ed25519 dWallet (network support permitting)...');
          const { buildAddDwalletTx } = await import('@mythos/wallet-core');
          const dkg2 = await core.ika.prepareSharedDkg(Curve.ED25519, account.address);
          const tx2 = buildAddDwalletTx(core.ids, walletId, {
            curve: IkaCurve.Ed25519,
            centralizedPublicKeyShareAndProof: dkg2.centralizedPublicKeyShareAndProof,
            userPublicOutput: dkg2.userPublicOutput,
            publicUserSecretKeyShare: dkg2.publicUserSecretKeyShare,
            sessionIdentifier: dkg2.sessionIdentifier,
          });
          // top up the wallet first - add_dwallet pays from wallet balances
          await exec(buildDepositBalancesTx(core.ids, walletId, 1_500_000_000n, 500_000_000n), 'fund');
          await exec(tx2, 'add ed25519 dwallet');
          solanaEnabled = true;
        } catch (solErr) {
          log(`WARNING: Solana dWallet failed (${(solErr as Error).message}). Continuing without Solana; it can be added later from the dashboard once supported.`);
        }
      }

      // c. wait for activation + derive addresses
      log('Waiting for the secp256k1 dWallet to activate (~30-60s)...');
      const state = await getWalletState(core.sui as never, walletId);
      const secpDwalletId = state.dwallets.get(IkaCurve.Secp256k1)!;
      const dwallet = await core.ika.getActiveDWallet(secpDwalletId);
      const evmAddr = deriveEvmAddress(dwallet.publicKey);
      const btcAddr = deriveBtcAddress(dwallet.publicKey, BTC_NETWORK_FOR[core.network]);
      log(`EVM address: ${evmAddr}`);
      log(`BTC address: ${btcAddr}`);

      let solPubkey: Uint8Array | null = null;
      if (solanaEnabled) {
        const s2 = await getWalletState(core.sui as never, walletId);
        const edId = s2.dwallets.get(IkaCurve.Ed25519);
        if (edId) {
          log('Waiting for ed25519 dWallet...');
          const edWallet = await core.ika.getActiveDWallet(edId);
          solPubkey = edWallet.publicKey;
          log(`Solana address: ${deriveSolanaAddress(solPubkey)}`);
        }
      }

      // d. configure chains + address book + finalize (single PTB)
      log('Configuring chain policies + recording the on-chain address book...');
      let setupTx;
      const configurableChains = enabledChains.filter(
        (c) => c.kind !== ChainKind.Solana || solanaEnabled,
      );
      for (const chain of configurableChains) {
        const d = chainDrafts[chain.chainKey];
        const dec = chain.decimals;
        const params = {
          chainKey: utf8(chain.chainKey),
          kind: chain.kind,
          evmChainId: chain.evmChainId ?? 0n,
          fastPathLimit: toBase(d.fastPath, dec),
          perTxLimit: toBase(d.perTx, dec),
          windowLimit: toBase(d.window, dec),
          windowMs: BigInt(Math.round(parseFloat(d.windowHours) * 3_600_000)),
          feeLimit: toBase(d.feeLimit, dec),
          allowlistEnabled: d.allowlistEnabled,
          allowUnverified: d.allowUnverified,
        };
        setupTx = buildConfigureChainTx(core.ids, walletId, params, setupTx);
        if (chain.kind === ChainKind.Btc) {
          buildRecordAddressTx(core.ids, walletId, utf8(chain.chainKey), p2wpkhScript(dwallet.publicKey), setupTx);
        } else if (chain.kind === ChainKind.Evm) {
          buildRecordAddressTx(core.ids, walletId, utf8(chain.chainKey), evmAddressBytes(evmAddr), setupTx);
        } else if (chain.kind === ChainKind.Solana && solPubkey) {
          buildRecordAddressTx(core.ids, walletId, utf8(chain.chainKey), solPubkey, setupTx);
        }
      }
      if (!setupTx) throw new Error('enable at least one chain');
      buildFinalizeSetupTx(core.ids, walletId, setupTx);
      await exec(setupTx, 'configure + finalize');

      // e. fund + presigns
      log('Funding fee reserves and requesting initial presigns...');
      await exec(buildDepositBalancesTx(core.ids, walletId, 2_000_000_000n, 1_000_000_000n), 'deposit');
      await exec(buildAddPresignTx(core.ids, walletId, IkaCurve.Secp256k1, 0, 2), 'presigns');

      log('Done. Wallet is live and fully recoverable from chain state.');
      onDone(walletId);
    } catch (e) {
      console.error(e);
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <div className="row spread">
        <h2>Create wallet</h2>
        <button onClick={onCancel}>cancel</button>
      </div>

      <div className="step-track" role="list" aria-label="creation steps">
        {(['Signers & policy', 'Chains & limits', 'Review & create'] as const).map((label, i) => {
          const n = i + 1;
          const cls = n === step ? 'step active' : n < step ? 'step done' : 'step';
          return (
            <div key={label} className={cls} role="listitem">
              <span className="num">{n < step ? '✓' : n}</span>
              <span>{label}</span>
            </div>
          );
        })}
      </div>

      {step === 1 && (
        <section className="card">
          <h3>1. Signers & policy timing</h3>
          {signers.map((s, i) => (
            <div className="row" key={i}>
              <input
                className="grow"
                value={s}
                placeholder="0x... Sui address"
                onChange={(e) => {
                  const next = [...signers];
                  next[i] = e.target.value.trim();
                  setSigners(next);
                }}
              />
              <button onClick={() => setSigners(signers.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <button onClick={() => setSigners([...signers, ''])}>+ add signer</button>
          <div className="row">
            <label>
              Spend threshold
              <input
                type="number"
                min={1}
                max={validSigners.length}
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value || '1'))}
              />
            </label>
            <label>
              Admin threshold (&ge; spend)
              <input
                type="number"
                min={threshold}
                max={validSigners.length}
                value={adminThreshold}
                onChange={(e) => setAdminThreshold(parseInt(e.target.value || '1'))}
              />
            </label>
          </div>
          <div className="row">
            <label>
              Spend timelock (hours)
              <input value={timelockSpendH} onChange={(e) => setTimelockSpendH(e.target.value)} />
            </label>
            <label>
              Admin timelock (hours)
              <input value={timelockAdminH} onChange={(e) => setTimelockAdminH(e.target.value)} />
            </label>
            <label>
              Request expiry (hours)
              <input value={expiryH} onChange={(e) => setExpiryH(e.target.value)} />
            </label>
          </div>
          <p className="muted">
            {validSigners.length} valid signer(s). Threshold {threshold}-of-{validSigners.length},
            admin changes need {adminThreshold} approvals plus a {timelockAdminH}h delay and can be
            vetoed during it. Spends above the fast-path limit wait {timelockSpendH}h after
            reaching threshold.
          </p>
          <button
            className="primary"
            disabled={
              validSigners.length === 0 ||
              threshold < 1 ||
              threshold > validSigners.length ||
              adminThreshold < threshold ||
              adminThreshold > validSigners.length
            }
            onClick={() => setStep(2)}
          >
            next: chains
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="card">
          <h3>2. Chains & limits</h3>
          {relevantChains.map((chain) => (
            <ChainConfigRow
              key={chain.chainKey}
              chain={chain}
              draft={chainDrafts[chain.chainKey]}
              onChange={(d) => setChainDrafts({ ...chainDrafts, [chain.chainKey]: d })}
            />
          ))}
          <p className="muted">
            Limits are enforced on-chain by the policy object. The fast path (single approval, no
            timelock) only ever applies to on-chain-verified transfers at or below its limit and is
            disabled by any rejection vote. Set it to 0 to require full threshold for everything.
          </p>
          <div className="row">
            <button onClick={() => setStep(1)}>back</button>
            <button className="primary" disabled={enabledChains.length === 0} onClick={() => setStep(3)}>
              next: review
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="card">
          <h3>3. Review & create</h3>
          <ul>
            <li>
              {threshold}-of-{validSigners.length} spend / {adminThreshold}-of-{validSigners.length} admin
            </li>
            <li>chains: {enabledChains.map((c) => c.displayName).join(', ')}</li>
            <li>signing: Ika dWallet in shared mode, cap held by the policy object forever</li>
            <li>cost: ~3.5 IKA + ~2 SUI for DKG, fee reserves and 2 presigns</li>
          </ul>
          {progress.map((p, i) => (
            <div key={i} className="progress-line">
              {p}
            </div>
          ))}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button onClick={() => setStep(2)} disabled={running}>
              back
            </button>
            <button className="primary" onClick={() => void run()} disabled={running}>
              {running ? 'creating...' : 'create wallet'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function ChainConfigRow({
  chain,
  draft,
  onChange,
}: {
  chain: ChainDescriptor;
  draft: ChainDraft;
  onChange: (d: ChainDraft) => void;
}) {
  return (
    <div className={`chain-row ${draft.enabled ? 'enabled' : ''}`} data-chain={chain.chainKey}>
      <label className="row">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
        />
        <span className="chain-swatch" aria-hidden="true" />
        <strong>{chain.displayName}</strong>
        <span className="muted">{chain.chainKey}</span>
      </label>
      {draft.enabled && (
        <div className="row wrap">
          <label>
            fast path ({chain.symbol})
            <input value={draft.fastPath} onChange={(e) => onChange({ ...draft, fastPath: e.target.value })} />
          </label>
          <label>
            per tx ({chain.symbol})
            <input value={draft.perTx} onChange={(e) => onChange({ ...draft, perTx: e.target.value })} />
          </label>
          <label>
            window ({chain.symbol})
            <input value={draft.window} onChange={(e) => onChange({ ...draft, window: e.target.value })} />
          </label>
          <label>
            window (h)
            <input value={draft.windowHours} onChange={(e) => onChange({ ...draft, windowHours: e.target.value })} />
          </label>
          {chain.kind !== ChainKind.SuiVault && (
            <label>
              max fee ({chain.symbol})
              <input value={draft.feeLimit} onChange={(e) => onChange({ ...draft, feeLimit: e.target.value })} />
            </label>
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={draft.allowlistEnabled}
              onChange={(e) => onChange({ ...draft, allowlistEnabled: e.target.checked })}
            />
            allowlist only
          </label>
        </div>
      )}
    </div>
  );
}
