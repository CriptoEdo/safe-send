import { defineConfig } from 'vite';

// Static app: build with `npm run build` and serve dist/ anywhere (Vercel, Netlify, GitHub Pages).
export default defineConfig({
  server: { port: 5173, strictPort: true },
  define: { global: 'globalThis' },
});
