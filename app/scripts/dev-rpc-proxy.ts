// Runs the /api/rpc Vercel function locally (for development and the UI tests in Mainnet mode):
//   HELIUS_MAINNET_RPC_URL=http://127.0.0.1:8899 node scripts/dev-rpc-proxy.ts      (listens on :8790)
//   DEV_API_PROXY=http://127.0.0.1:8790 VITE_CLUSTER=mainnet-beta npx vite         (vite forwards /api to it)
import { createServer } from 'node:http';
import { POST } from '../api/rpc.ts';

const port = Number(process.env.PORT ?? 8790);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])) as [string, string][],
    body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  const response = req.method === 'POST' && req.url === '/api/rpc' ? await POST(request) : new Response('Not found', { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}).listen(port, () => console.log(`/api/rpc on http://127.0.0.1:${port} → ${process.env.HELIUS_MAINNET_RPC_URL}`));
