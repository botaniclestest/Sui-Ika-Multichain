import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import type { SuiNetwork } from '@mythos/wallet-core';
import { getDeployment, setDeploymentOverride } from './config';
import { useCore, useMyWallets } from './hooks';
import { CreateWizard } from './components/CreateWizard';
import { Dashboard } from './components/Dashboard';
import stinkySquid from './assets/stinky-squid.svg';

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'wallet'; walletId: string };
type GasPuff = {
  id: number;
  x: number;
  y: number;
  size: number;
  driftX: number;
  driftY: number;
  delayMs: number;
};

export default function App() {
  const dAppKit = useDAppKit();
  const dAppNetwork = useCurrentNetwork() as SuiNetwork;
  const [network, setNetwork] = useState<SuiNetwork>('testnet');
  const [view, setView] = useState<View>({ kind: 'list' });
  const account = useCurrentAccount();
  const core = useCore(network);
  const { wallets, loading, refresh } = useMyWallets(core);
  const deployment = getDeployment(network);
  const puffId = useRef(0);
  const [gasPuffs, setGasPuffs] = useState<GasPuff[]>([]);

  useEffect(() => {
    if (dAppNetwork !== network) dAppKit.switchNetwork(network);
  }, [dAppKit, dAppNetwork, network]);

  function changeNetwork(next: SuiNetwork) {
    setNetwork(next);
    dAppKit.switchNetwork(next);
    setView({ kind: 'list' });
  }

  function emitGasPuff(strength = 1) {
    const count = 4 + Math.round(strength * 4);
    const burst: GasPuff[] = Array.from({ length: count }, (_, i) => ({
      id: ++puffId.current,
      x: 69 + Math.random() * 15,
      y: 42 + Math.random() * 24,
      size: 42 + Math.random() * 78,
      driftX: -70 - Math.random() * 105,
      driftY: -18 + Math.random() * 44,
      delayMs: i * 55,
    }));
    setGasPuffs((current) => [...current.slice(-18), ...burst]);
  }

  function maybeEmitActionGas(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('button.primary, button.danger, button.wallet-link, .connect-slot button, .tabs button, select')) {
      emitGasPuff(target.closest('select') ? 1.35 : 1);
    }
  }

  useEffect(() => {
    if (gasPuffs.length === 0) return;
    const timeout = window.setTimeout(() => {
      setGasPuffs((current) => current.slice(-4));
    }, 3600);
    return () => window.clearTimeout(timeout);
  }, [gasPuffs]);

  return (
    <>
      <div className="squid-scene" aria-hidden="true">
        <div className="water-depth" />
        <div className="squid-glow" />
        <div className="squid-figure">
          <span className="squid-shadow" />
          <span className="squid-fin squid-fin-left" />
          <span className="squid-fin squid-fin-right" />
          <span className="squid-mantle" />
          <span className="squid-head" />
          <span className="squid-eye squid-eye-left" />
          <span className="squid-eye squid-eye-right" />
          <span className="squid-tentacle squid-tentacle-1" />
          <span className="squid-tentacle squid-tentacle-2" />
          <span className="squid-tentacle squid-tentacle-3" />
          <span className="squid-tentacle squid-tentacle-4" />
          <span className="squid-tentacle squid-tentacle-5" />
          <span className="squid-tentacle squid-tentacle-6" />
        </div>
        <div className="water-haze" />
        <div className="water-caustics" />
        <div className="bubble-field">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="ink-gas-layer">
          {gasPuffs.map((puff) => (
            <span
              key={puff.id}
              className="ink-gas-puff"
              style={
                {
                  left: `${puff.x}vw`,
                  top: `${puff.y}vh`,
                  width: `${puff.size}px`,
                  height: `${puff.size}px`,
                  '--drift-x': `${puff.driftX}px`,
                  '--drift-y': `${puff.driftY}px`,
                  animationDelay: `${puff.delayMs}ms`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>
      <div
        className="shell"
        onClickCapture={(event) => maybeEmitActionGas(event.target)}
        onChangeCapture={(event) => maybeEmitActionGas(event.target)}
      >
      <header>
        <div className="brand" onClick={() => setView({ kind: 'list' })}>
          <span className="brand-mark">
            <img className="brand-glyph" src={stinkySquid} alt="" aria-hidden="true" />
          </span>
          <span className="brand-text">
            stINKy<span className="accent">Multichain Policy Wallet</span>
          </span>
        </div>
        <div className="header-right">
          <select value={network} onChange={(e) => changeNetwork(e.target.value as SuiNetwork)}>
            <option value="testnet">Sui Testnet</option>
            <option value="mainnet">Sui Mainnet</option>
          </select>
          <span className="connect-slot">
            <ConnectButton />
          </span>
        </div>
      </header>

      {!account && (
        <main className="card center">
          <div className="landing-chains" aria-hidden="true">
            <span className="chain-dot" data-chain="btc:mainnet" />
            <span className="chain-dot" data-chain="eip155:1" />
            <span className="chain-dot" data-chain="solana:mainnet" />
            <span className="chain-dot" data-chain="sui:vault" />
          </div>
          <h1>stINKy Multichain Policy Wallet</h1>
          <p>
            BTC, EVM, Solana and Sui assets under one Sui-enforced policy, signed by Ika MPC.
            Nothing to back up except your Sui key: every wallet, address, rule and pending
            request is recoverable from chain state alone.
          </p>
          <span className="connect-slot">
            <ConnectButton />
          </span>
        </main>
      )}

      {account && !deployment && (
        <main className="card">
          <h2>Point me at a deployment</h2>
          <p>
            Enter the published package id and registry id (public constants - find them in
            deployments.json of the repo, or any explorer).
          </p>
          <DeploymentForm network={network} onSaved={() => window.location.reload()} />
        </main>
      )}

      {account && deployment && view.kind === 'list' && (
        <main>
          <div className="row spread">
            <h2>Your wallets</h2>
            <div>
              <button onClick={() => void refresh()} disabled={loading}>
                {loading ? 'scanning chain...' : 'rescan'}
              </button>{' '}
              <button className="primary" onClick={() => setView({ kind: 'create' })}>
                Create wallet
              </button>
            </div>
          </div>
          {wallets === null && <p>Scanning registry and owned objects...</p>}
          {wallets?.length === 0 && (
            <p>
              No wallets found for {account.address.slice(0, 10)}... on {network}. Create one, or
              switch networks.
            </p>
          )}
          <ul className="wallet-list">
            {wallets?.map((id) => (
              <li key={id}>
                <button className="wallet-link" onClick={() => setView({ kind: 'wallet', walletId: id })}>
                  {id}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">
            Discovery is fully on-chain: owned SignerCaps, then the shared registry, then events.
            This page works identically from any rebuilt frontend.
          </p>
        </main>
      )}

      {account && deployment && view.kind === 'create' && (
        <CreateWizard
          core={core}
          onDone={(walletId) => setView({ kind: 'wallet', walletId })}
          onCancel={() => setView({ kind: 'list' })}
        />
      )}

      {account && deployment && view.kind === 'wallet' && (
        <Dashboard core={core} walletId={view.walletId} onBack={() => setView({ kind: 'list' })} />
      )}
      </div>
    </>
  );
}

function DeploymentForm({ network, onSaved }: { network: SuiNetwork; onSaved: () => void }) {
  const [pkg, setPkg] = useState('');
  const [registry, setRegistry] = useState('');
  return (
    <div className="form">
      <label>
        Package id
        <input value={pkg} onChange={(e) => setPkg(e.target.value.trim())} placeholder="0x..." />
      </label>
      <label>
        Registry id
        <input
          value={registry}
          onChange={(e) => setRegistry(e.target.value.trim())}
          placeholder="0x..."
        />
      </label>
      <button
        className="primary"
        disabled={!pkg.startsWith('0x') || !registry.startsWith('0x')}
        onClick={() => {
          setDeploymentOverride(network, { policyPackageId: pkg, registryId: registry });
          onSaved();
        }}
      >
        Save
      </button>
    </div>
  );
}
