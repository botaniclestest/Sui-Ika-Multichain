import { useEffect, useState } from 'react';
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import type { SuiNetwork } from '@mythos/wallet-core';
import { getDeployment, setDeploymentOverride } from './config';
import { useCore, useMyWallets } from './hooks';
import { CreateWizard } from './components/CreateWizard';
import { Dashboard } from './components/Dashboard';
import stinkySquid from './assets/stinky-squid.svg';
import stinkyBackdrop from '../../../stINKy.jpg';

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'wallet'; walletId: string };

export default function App() {
  const dAppKit = useDAppKit();
  const dAppNetwork = useCurrentNetwork() as SuiNetwork;
  const [network, setNetwork] = useState<SuiNetwork>('testnet');
  const [view, setView] = useState<View>({ kind: 'list' });
  const account = useCurrentAccount();
  const core = useCore(network);
  const { wallets, loading, refresh } = useMyWallets(core);
  const deployment = getDeployment(network);

  useEffect(() => {
    if (dAppNetwork !== network) dAppKit.switchNetwork(network);
  }, [dAppKit, dAppNetwork, network]);

  function changeNetwork(next: SuiNetwork) {
    setNetwork(next);
    dAppKit.switchNetwork(next);
    setView({ kind: 'list' });
  }

  return (
    <div className="shell">
      <div className="squid-backdrop" style={{ backgroundImage: `url(${stinkyBackdrop})` }} aria-hidden="true" />
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
