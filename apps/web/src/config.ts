/**
 * Deployment configuration.
 *
 * The package id and registry id are PUBLIC constants - they are baked in
 * from deployments.json at build time and can be overridden at runtime
 * (?pkg=0x...&registry=0x... or the settings form). They are deliberately
 * NOT secrets: knowing them plus your Sui key is sufficient to recover
 * every wallet even if this frontend ceases to exist.
 */

import type { SuiNetwork } from '@mythos/wallet-core';
import deployments from '../../../deployments.json';

export interface AppDeployment {
  /** original package id (types/events/discovery) */
  policyPackageId: string;
  /** latest package id after upgrades (move call target); optional */
  latestPackageId?: string;
  registryId: string;
}

const LS_KEY = 'mythos-deployment-override';

export function getDeployment(network: SuiNetwork): AppDeployment | null {
  const params = new URLSearchParams(window.location.search);
  const pkg = params.get('pkg');
  const registry = params.get('registry');
  if (pkg && registry) return { policyPackageId: pkg, registryId: registry };

  const stored = localStorage.getItem(`${LS_KEY}:${network}`);
  if (stored) {
    try {
      return JSON.parse(stored) as AppDeployment;
    } catch {
      /* fall through */
    }
  }

  const dep = (deployments as Record<string, AppDeployment | undefined>)[network];
  if (dep?.policyPackageId) return dep;
  return null;
}

export function setDeploymentOverride(network: SuiNetwork, dep: AppDeployment): void {
  localStorage.setItem(`${LS_KEY}:${network}`, JSON.stringify(dep));
}

export const BTC_NETWORK_FOR: Record<SuiNetwork, 'mainnet' | 'testnet'> = {
  mainnet: 'mainnet',
  testnet: 'testnet',
};
