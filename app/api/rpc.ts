// Vercel function: the Solana RPC for the Mainnet app (POST /api/rpc). It forwards JSON-RPC requests to the
// Helius URL in HELIUS_MAINNET_RPC_URL (a server-only secret), so the key never reaches the browser, and only
// the requests the app makes: the methods below, getProgramAccounts only on the Safe Send program, from this
// site's own pages.

const SAFE_SEND_PROGRAM = 'EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg';

// What the app calls (src/main.ts, src/lib, src/wallet.ts).
const ALLOWED_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getProgramAccounts', 'getRecentPrioritizationFees', 'getSignatureStatuses',
  'getTokenAccountsByOwner', 'sendTransaction', 'simulateTransaction',
]);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 10;

// The site's origins: the domain, and this project's Vercel deployments (production and previews).
const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?safe-send\.app$/,
  /^https:\/\/safe-send(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];

interface RpcRequest { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown }

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const refuse = (status: number, message: string, id: unknown = null) =>
  reply(status, { jsonrpc: '2.0', id, error: { code: -32600, message } });

// Why a request is refused, or null if it can be forwarded.
export function refusal(request: RpcRequest): string | null {
  if (typeof request !== 'object' || request === null || typeof request.method !== 'string') return 'Invalid request';
  if (!ALLOWED_METHODS.has(request.method)) return `Method not allowed: ${request.method}`;
  if (request.method === 'getProgramAccounts') {
    const program = Array.isArray(request.params) ? request.params[0] : undefined;
    if (program !== SAFE_SEND_PROGRAM) return 'getProgramAccounts is only allowed on the Safe Send program';
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const upstream = process.env.HELIUS_MAINNET_RPC_URL;
  if (!upstream) return refuse(500, 'RPC not configured');

  const origin = request.headers.get('origin') ?? '';
  if (!ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) return refuse(403, 'Origin not allowed');

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return refuse(413, 'Request too large');
  let body: RpcRequest | RpcRequest[];
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'Invalid JSON');
  }
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length === 0 || requests.length > MAX_BATCH) return refuse(400, 'Invalid batch');
  for (const item of requests) {
    const reason = refusal(item);
    if (reason) return refuse(403, reason, item?.id ?? null);
  }

  try {
    const response = await fetch(upstream, {
      method: 'POST',
      // Helius restricts the key to our domains: present the request as coming from the site.
      headers: { 'content-type': 'application/json', origin: 'https://www.safe-send.app' },
      body: text,
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return refuse(502, 'RPC unreachable');
  }
}
