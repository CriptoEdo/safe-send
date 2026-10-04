import { defineConfig } from 'vite';

// Static app (npm run build → dist/) plus the /api/rpc Vercel function used on Mainnet (api/rpc.ts).
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // /api/rpc runs as a Vercel function in production; locally, scripts/dev-rpc-proxy.ts serves it.
    proxy: process.env.DEV_API_PROXY ? { '/api': process.env.DEV_API_PROXY } : undefined,
  },
  define: { global: 'globalThis' },
});
