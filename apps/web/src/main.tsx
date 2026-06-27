import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { dAppKit } from './dapp-kit';
import App from './App';
import './styles.css';

const bigintPrototype = BigInt.prototype as unknown as { toJSON?: () => string };

if (!bigintPrototype.toJSON) {
  // React dev render logging stringifies props/state, including recovered wallet bigint values.
  Object.defineProperty(bigintPrototype, 'toJSON', {
    value: function toJSON(this: bigint) {
      return this.toString();
    },
    configurable: true,
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      <App />
    </DAppKitProvider>
  </StrictMode>,
);
