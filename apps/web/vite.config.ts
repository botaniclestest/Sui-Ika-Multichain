import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    // Buffer/process polyfills for @solana/web3.js in the browser
    nodePolyfills({ globals: { Buffer: true, process: true } }),
  ],
  build: {
    target: 'es2022',
  },
});
