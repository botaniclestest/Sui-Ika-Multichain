import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    // Buffer/process polyfills for @solana/web3.js in the browser
    nodePolyfills({ globals: { Buffer: true, process: true } }),
  ],
  optimizeDeps: {
    // @ika.xyz/ika-wasm's web loader resolves its .wasm via import.meta.url.
    // If Vite prebundles it into node_modules/.vite, that URL points at the
    // optimized cache and the dev server serves index.html instead of WASM.
    include: ['poseidon-lite'],
    exclude: ['@ika.xyz/sdk', '@ika.xyz/ika-wasm'],
  },
  build: {
    target: 'es2022',
  },
});
