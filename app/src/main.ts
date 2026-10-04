import './polyfills.ts';
import './style.css';
import { Connection, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  cancelSolIx, cancelTokenIx, checkRecipientFees, claimSolIx, claimTokenIx, escrowAddress, incomingTransfers,
  fetchConfig, mintInfos, newTransferId, outgoingTransfers, percentFee, sendSolIx, sendTokenIxs, topUpIx, transferFeeOf,
  type FeeCheck, type FeeConfig, type MintInfo, type PendingTransfer,
} from './lib/safeSend.ts';
import { BASE_FEE_LAMPORTS, MAX_PRIORITY_LAMPORTS, cappedPrice, claimPriorityCap, computeBudget, recentPrice } from './lib/fees.ts';
import { approveAccount, connectWithSignature, connectedWallets, disconnectWallet, isDisconnected, phantom, rememberWallet, selectedAccount, signAndSend } from './wallet.ts';

import { IS_MAINNET, NETWORK_NAME, RPC_URL, explorer } from './network.ts';
// Rate limits are retried below with a bounded number of attempts, not by web3.js's own open-ended backoff.
const connection = new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true });
const app = document.getElementById('app')!;

type Tab = 'send' | 'incoming' | 'sent';
type Flash = { tab: Tab; target: 'send-result' | 'list-result'; html: string; kind: 'ok' | 'error' | 'info' };
interface TokenHolding { mint: PublicKey; account: PublicKey; amount: bigint; decimals: number }

const emptyForm = (asset = 'SOL') => ({ amount: '', recipient: '', asset });

const state = {
  wallet: null as PublicKey | null,
  loaded: false, // balances and transfers of `wallet` fetched at least once
  loadError: false, // the last refresh failed
  sol: 0,
  tokens: [] as TokenHolding[],
  config: null as FeeConfig | null, // Safe Send's fees and treasury
  incoming: [] as PendingTransfer[],
  outgoing: [] as PendingTransfer[],
  tab: 'send' as Tab,
  // A transfer opened from a shared link: shown once in the right tab.
  highlight: new URLSearchParams(location.search).get('transfer'),
  highlightShown: false,
  busy: false, // a transaction is waiting for Phantom or the network
  menu: false, // wallet menu open
  // A connected wallet the user picked, waiting for them to select it in Phantom (Phantom signs with its own
  // selected account, a website cannot change it).
  pending: null as string | null,
  // Shown above the content: how to add a wallet, or the account selected in Phantom is not connected here.
  notice: null as null | { kind: 'add'; stillSelected?: string } | { kind: 'not-connected'; account: string | null },
  // The send form and its checks live here so re-rendering never loses what the user typed.
  form: emptyForm(),
  fee: null as null | { recipient: string; check: FeeCheck }, // fee check of the recipient in the form
  check: null as null | { cls: string; html: string }, // what the recipient check shows
  flash: null as Flash | null, // result of the last action, under the send button or the list
};

// Transfers claimed or cancelled here: hidden right away, even if the RPC still returns them for a moment.
const closed = new Set<string>();

// --- Formatting ---

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const date = (ms: number) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function units(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function parseUnits(text: string, decimals: number): bigint | null {
  const match = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? '');
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

const sol = (lamports: number | bigint) => units(BigInt(lamports), 9);
// SOL rounded up to 6 decimals, for estimates shown before signing.
const solUp = (lamports: number) => sol(Math.ceil(lamports / 1_000) * 1_000);

// Mints (token program, decimals, Token-2022 extensions), loaded with the wallet's data so rendering never
// waits for the network.
const mintCache = new Map<string, MintInfo>();
async function loadMints(mints: PublicKey[]): Promise<void> {
  const missing = mints.filter((m) => !mintCache.has(m.toBase58()));
  if (missing.length) (await mintInfos(connection, missing)).forEach((info, key) => mintCache.set(key, info));
}

function amountLabel(t: PendingTransfer): string {
  if (t.isSol) return `${sol(t.amount)} SOL`;
  return `${units(t.amount, mintCache.get(t.mint.toBase58())?.decimals ?? 0)} <span class="mint" title="${t.mint.toBase58()}">${short(t.mint)}</span>`;
}

// Program errors (Anchor custom errors start at 6000) and wallet rejections, in plain words.
function describeError(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  if (/User rejected|rejected the request/i.test(text)) return 'You rejected the request in Phantom.';
  if (/not been authorized/i.test(text)) return 'Phantom has not connected this account to Safe Send. Approve the connection in Phantom and try again.';
  if (/block height exceeded|expired/i.test(text)) return 'The transaction expired before it was confirmed. Nothing was sent: try again.';
  if (/failed to fetch|network|429|timed? ?out/i.test(text)) return `Could not reach ${NETWORK_NAME}. Check your connection and try again.`;
  const logs = err instanceof SendTransactionError ? (err.logs ?? []).join('\n') : text;
  const anchor = /Error Message: ([^.\n]+)/.exec(logs);
  if (anchor) return `${anchor[1]}.`;
  if (/insufficient (funds|lamports)|0x1\b/i.test(logs)) return 'Not enough SOL for this transaction (amount + fees).';
  return escape(text.length > 220 ? `${text.slice(0, 220)}…` : text);
}

// --- Data ---

// A request that does not answer in time counts as failed, so loading always ends.
const REQUEST_TIMEOUT_MS = 6_000;
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Request timed out')), REQUEST_TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Public RPCs reject bursts of requests: retry a failed call a couple of times before giving up.
async function retry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(call());
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

let refreshSeq = 0;
let lastRefresh = 0;
// Switching tabs reloads from the network at most this often; transactions and wallet changes always reload.
const TAB_REFRESH_MS = 20_000;

// One load at a time per wallet: asking again while it runs reuses it (Phantom can repeat accountChanged), and
// `force` (after a transaction) runs one more load once it ends, so the new state is always fetched.
let inFlight: { owner: string; promise: Promise<void> } | null = null;
let reloadAfter = false;

function refresh(force = false): Promise<void> {
  const owner = state.wallet;
  if (!owner) return Promise.resolve();
  if (inFlight?.owner === owner.toBase58()) {
    if (force) reloadAfter = true;
    return inFlight.promise;
  }
  const promise: Promise<void> = load(owner).finally(() => {
    if (inFlight?.promise !== promise) return;
    inFlight = null;
    if (reloadAfter) { reloadAfter = false; void refresh(); }
  });
  inFlight = { owner: owner.toBase58(), promise };
  return promise;
}

// Fetches balances and transfers of `owner`, then repaints. Results for a wallet that is no longer active, or
// of a load that was superseded, are dropped.
async function load(owner: PublicKey): Promise<void> {
  const seq = ++refreshSeq;
  lastRefresh = Date.now();
  const current = () => seq === refreshSeq && state.wallet?.equals(owner);
  try {
    const [lamports, classic, token2022, incoming, outgoing, config] = await Promise.all([
      retry(() => connection.getBalance(owner)),
      retry(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })),
      retry(() => connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })),
      retry(() => incomingTransfers(connection, owner)),
      retry(() => outgoingTransfers(connection, owner)),
      retry(() => fetchConfig(connection)),
    ]);
    // One entry per mint (the account with the most tokens, if the wallet has several).
    const holdings = new Map<string, TokenHolding>();
    for (const { pubkey, account } of [...classic.value, ...token2022.value]) {
      const info = account.data.parsed.info;
      const holding = { mint: new PublicKey(info.mint), account: pubkey, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals };
      const known = holdings.get(info.mint);
      if (holding.amount > 0n && (!known || holding.amount > known.amount)) holdings.set(info.mint, holding);
    }
    const tokens = [...holdings.values()];
    await retry(() => loadMints([...tokens.map((t) => t.mint), ...[...incoming, ...outgoing].filter((t) => !t.isSol).map((t) => t.mint)]));
    if (!current()) return;
    const open = (t: PendingTransfer) => !closed.has(t.address.toBase58());
    Object.assign(state, {
      loaded: true,
      loadError: false,
      sol: lamports,
      tokens,
      config,
      incoming: incoming.filter(open).sort((a, b) => b.createdAt - a.createdAt),
      outgoing: outgoing.filter(open).sort((a, b) => b.createdAt - a.createdAt),
    });
    if (state.highlight && !state.highlightShown) {
      const tab = state.incoming.some((t) => t.address.toBase58() === state.highlight) ? 'incoming'
        : state.outgoing.some((t) => t.address.toBase58() === state.highlight) ? 'sent' : null;
      if (tab) Object.assign(state, { tab, highlightShown: true });
    }
  } catch {
    if (!current()) return;
    lastRefresh = 0; // try again on the next tab switch
    // With data already on screen, keep it and stay quiet: the next refresh will update it.
    if (state.loaded) return;
    state.loadError = true;
  }
  paint();
}

// Repaints after new data. On the send tab only the parts that show data change, so typing is never interrupted.
function paint(): void {
  if (!state.wallet || state.tab !== 'send' || !document.getElementById('amount')) return render();
  replace('.segments', tabs());
  replace('#status', status());
  const select = document.getElementById('asset') as HTMLSelectElement;
  if (document.activeElement !== select) {
    state.form.asset = currentAsset();
    select.innerHTML = assetOptions();
  }
  document.getElementById('balance')!.textContent = balanceLabel(state.form.asset);
  document.getElementById('token-note')!.innerHTML = tokenNote(state.form.asset);
  document.getElementById('fee-note')!.textContent = feeNote(state.form.asset);
}

// Replaces one element with fresh HTML and binds the new element's buttons.
function replace(selector: string, html: string): void {
  const el = app.querySelector(selector);
  if (!el) return;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const fresh = template.content.firstElementChild!;
  el.replaceWith(fresh);
  bind(fresh);
}

// --- Rendering ---

const SHIELD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 4.5 5.4v5.9c0 4.6 3.1 8.6 7.5 10.2 4.4-1.6 7.5-5.6 7.5-10.2V5.4L12 2.5Z" fill="currentColor"/><path d="m8.6 12.1 2.4 2.4 4.5-4.6" fill="none" stroke="var(--logo-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function header(): string {
  const active = state.wallet?.toBase58();
  const walletRow = (w: string) => `
    <button role="menuitem" class="wallet-row ${w === active ? 'current' : ''}" data-use="${w}">
      <span class="avatar small"></span>${short(w)}${w === active ? '<span class="tick">✓</span>' : ''}
    </button>`;
  const right = state.wallet
    ? `<div class="wallet-wrap">
        <button class="wallet" data-menu aria-haspopup="menu" aria-expanded="${state.menu}" title="${active}">
          <span class="avatar"></span>${short(state.wallet)}<span class="caret">▾</span>
        </button>
        ${state.menu ? `<div class="menu" role="menu">
          <div class="menu-head"><span class="muted">Active wallet</span><code>${short(state.wallet)}</code><span class="muted">${state.loaded ? `${sol(state.sol)} SOL` : '…'}</span></div>
          <button role="menuitem" data-copy>Copy address</button>
          <div class="menu-label">Switch wallet</div>
          ${connectedWallets().map(walletRow).join('')}
          <button role="menuitem" data-add>＋ Add another wallet</button>
          <button role="menuitem" class="danger" data-disconnect>Disconnect ${short(state.wallet)}</button>
        </div>` : ''}
      </div>`
    : ''; // not connected: the welcome screen has the connect button
  return `
    <header class="top">
      <div class="brand"><span class="logo">${SHIELD}</span>Safe Send${IS_MAINNET ? '' : '<span class="chip">Devnet</span>'}</div>
      ${right}
    </header>`;
}

// What needs the user's attention about wallets, above the content.
function walletNotice(): string {
  if (state.pending) {
    return `<div class="switch-hint">
      <strong>Select ${short(state.pending)} in Phantom</strong>
      Open Phantom and choose this account at the top: Safe Send switches as soon as you do.
      <button class="link-button" data-cancel-switch>Cancel</button>
    </div>`;
  }
  if (state.notice?.kind === 'add') {
    // Phantom does not always tell the site about a switch to an account that never connected (e.g. from its
    // side panel), so the user confirms with Connect once the account is selected.
    const still = state.notice.stillSelected;
    return `<div class="switch-hint">
      <strong>Add another wallet</strong>
      ${still ? `Phantom still has ${short(still)} selected: select the other account at the top of Phantom first.` : 'Select the other account in Phantom, then connect it here.'}
      <button class="pill primary small" data-connect>Connect</button>
    </div>`;
  }
  if (state.notice?.kind === 'not-connected') {
    return `<div class="switch-hint">
      <strong>${state.notice.account ? `${short(state.notice.account)} is not connected` : 'This Phantom account is not connected'}</strong>
      ${state.notice.account && isDisconnected(state.notice.account)
        ? `You disconnected it: connect it again with a signature${connectedWallets().length ? ', or select one of your wallets in Phantom' : ''}.
          <button class="pill primary small" data-connect>Connect &amp; sign</button>`
        : `Approve it in Phantom to use it here.
          <button class="pill primary small" data-connect>Connect</button>`}
    </div>`;
  }
  return '';
}

function welcome(): string {
  const wallets = connectedWallets();
  return `
    <section class="welcome">
      <div class="orb">${SHIELD}</div>
      <h1>Send safely.</h1>
      <p>Your transfer waits until the right wallet claims it.<br/>Wrong address? Just take it back.</p>
      ${walletNotice()}
      ${wallets.length ? `<div class="wallet-list">
        <div class="menu-label">Your wallets</div>
        ${wallets.map((w) => `<button class="wallet-row" data-use="${w}"><span class="avatar small"></span>${short(w)}</button>`).join('')}
      </div>` : ''}
      <button class="pill primary big" data-connect>${!phantom() ? 'Get Phantom' : wallets.length ? 'Connect another wallet' : 'Connect Phantom'}</button>
      <p class="hint">Connecting asks for a free signature.${IS_MAINNET ? '' : ' Use Devnet: Phantom → Settings → Developer settings → Testnet mode'}</p>
    </section>`;
}

function tabs(): string {
  const tab = (id: Tab, label: string, count?: number) =>
    `<button class="seg ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`;
  return `<nav class="segments">${tab('send', 'Send')}${tab('incoming', 'Receive', state.incoming.length)}${tab('sent', 'Pending', state.outgoing.length)}</nav>`;
}

// A failed refresh: the data on screen may be old.
const status = () => `<div id="status">${state.loadError
  ? `<div class="notice error status-error">Could not reach ${NETWORK_NAME}${state.loaded ? ', balances may be out of date' : ''}. <button class="link-button" data-retry>Retry</button></div>`
  : ''}</div>`;

// The asset in the form, or SOL if that token is no longer in the wallet.
const currentAsset = () => state.form.asset === 'SOL' || state.tokens.some((t) => t.mint.toBase58() === state.form.asset) ? state.form.asset : 'SOL';

const assetOptions = () => [{ value: 'SOL', label: 'SOL' }]
  .concat(state.tokens.map((t) => ({ value: t.mint.toBase58(), label: short(t.mint) })))
  .map((o) => `<option value="${o.value}" ${o.value === state.form.asset ? 'selected' : ''}>${o.label}</option>`)
  .join('');

// What to know before sending a Token-2022 token with special rules.
function tokenNote(asset: string): string {
  const info = asset === 'SOL' ? undefined : mintCache.get(asset);
  if (!info) return '';
  if (info.transferHook) return '<span class="error">This token uses a transfer hook, which Safe Send does not support.</span>';
  const notes: string[] = [];
  if (info.transferFee) {
    notes.push(`This token charges a ${info.transferFee.basisPoints / 100}% fee on every transfer: the escrow receives your amount minus the fee, and the claim (or a cancel) pays it once more.`);
  }
  if (info.permanentDelegate) notes.push("This token's issuer can move it from any account, including the escrow.");
  return notes.join(' ');
}

// --- Cost before signing ---

// Rent deposits by account size, and which token accounts exist (recipient's, treasury's), cached.
const rentCache = new Map<number, number>();
const accountExists = new Map<string, boolean>();
const rentFor = async (bytes: number) => {
  if (!rentCache.has(bytes)) rentCache.set(bytes, await retry(() => connection.getMinimumBalanceForRentExemption(bytes)));
  return rentCache.get(bytes)!;
};
async function exists(address: PublicKey): Promise<boolean> {
  const key = address.toBase58();
  if (!accountExists.has(key)) accountExists.set(key, !!(await retry(() => connection.getAccountInfo(address))));
  return accountExists.get(key)!;
}

// Recent priority fees on the accounts a send writes (sender and treasury), refreshed at most every 20 s.
let feesCache: { key: string; at: number; price: number } | null = null;
async function priorityPrice(writable: PublicKey[]): Promise<number> {
  const key = writable.map((k) => k.toBase58()).join();
  if (!feesCache || feesCache.key !== key || Date.now() - feesCache.at > 20_000) {
    const fees = await retry(() => connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable }));
    feesCache = { key, at: Date.now(), price: recentPrice(fees) };
  }
  return feesCache.price;
}

// Compute units a send typically uses (measured on the program, with margin): the exact amount is measured
// when sending, so the network fee shown before is an estimate.
const SOL_SEND_UNITS = 20_000;
const TOKEN_SEND_UNITS = 60_000;
const ATA_CREATE_UNITS = 25_000;

let costToken = 0;

// What the sender pays for the transfer in the form: the amount and Safe Send's fee, plus the SOL deposits for
// the accounts the transfer opens (returned on claim or cancel), the token accounts it creates for the recipient
// or the treasury (not returned), the recipient's claim-fee top-up, and the network fee.
async function updateCost(): Promise<void> {
  const out = document.getElementById('cost-note');
  const token = ++costToken;
  const show = (html: string) => { if (token === costToken && out) out.innerHTML = html; };
  const config = state.config;
  const fee = state.fee;
  const asset = currentAsset();
  const holding = asset === 'SOL' ? null : state.tokens.find((t) => t.mint.toBase58() === asset);
  const mint = holding ? mintCache.get(asset) : null;
  const amount = parseUnits(state.form.amount, holding ? holding.decimals : 9);
  if (!config || !fee || fee.recipient !== state.form.recipient.trim() || !amount || amount <= 0n || (holding && !mint)) return show('');
  try {
    const recipient = new PublicKey(fee.recipient);
    const percent = percentFee(config, amount);
    const ESCROW_BYTES = 194;
    let deposit = await rentFor(ESCROW_BYTES);
    let accounts = 0; // token accounts created for others, paid by the sender
    if (mint) {
      deposit += await rentFor(mint.vaultSize);
      const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.mint, owner, true, mint.tokenProgram);
      if (!(await exists(ata(recipient)))) accounts += await rentFor(mint.ataSize);
      if (percent > 0n && !(await exists(ata(config.treasury)))) accounts += await rentFor(mint.ataSize);
    }
    const flat = Number(config.flatFeeLamports);
    // Network fee: signature fee + priority fee at the current price, within the same cap as when sending
    const computeUnits = mint ? TOKEN_SEND_UNITS + ATA_CREATE_UNITS * (percent > 0n ? 2 : 1) : SOL_SEND_UNITS;
    const price = cappedPrice(await priorityPrice([state.wallet!, config.treasury]), computeUnits, MAX_PRIORITY_LAMPORTS);
    const networkFee = BASE_FEE_LAMPORTS + Math.ceil((computeUnits * price) / 1_000_000);
    const solTotal = (mint ? 0 : Number(amount + percent)) + flat + deposit + accounts + fee.check.topUp + networkFee;
    const unit = holding ? short(holding.mint) : 'SOL';
    const parts = [`<strong>${mint ? `${units(amount + percent, holding!.decimals)} ${unit} + ` : ''}${solUp(solTotal)} SOL</strong>`];
    const details = [`${solUp(deposit)} SOL is a deposit you get back on claim or cancel`];
    if (accounts) details.push(`${solUp(accounts)} SOL opens a token account for ${percent > 0n ? 'the recipient or the fee' : 'the recipient'}`);
    if (fee.check.topUp) details.push(`${solUp(fee.check.topUp)} SOL covers the recipient's claim fee`);
    details.push(`about ${solUp(networkFee)} SOL is the network fee`);
    show(`You pay about ${parts.join('')}. <span class="muted">${details.join('; ')}.</span>`);
  } catch {
    show('');
  }
}

// Safe Send's fee for sending `state.form.amount` of `asset`, paid on top (empty while there are no fees).
function feeNote(asset: string): string {
  const config = state.config;
  if (!config || (config.feeBps === 0 && config.flatFeeLamports === 0n)) return '';
  const holding = asset === 'SOL' ? null : state.tokens.find((t) => t.mint.toBase58() === asset);
  const decimals = holding ? holding.decimals : 9;
  const unit = holding ? short(holding.mint) : 'SOL';
  const amount = parseUnits(state.form.amount, decimals) ?? 0n;
  const parts: string[] = [];
  if (config.feeBps > 0) parts.push(`${units(percentFee(config, amount), decimals)} ${unit} (${config.feeBps / 100}%)`);
  if (config.flatFeeLamports > 0n) parts.push(`${sol(config.flatFeeLamports)} SOL`);
  return `Safe Send fee, paid on top: ${parts.join(' + ')}`;
}

const balanceLabel = (asset: string) => {
  if (!state.loaded) return 'Balance …';
  if (asset === 'SOL') return `Balance ${sol(state.sol)} SOL`;
  const t = state.tokens.find((x) => x.mint.toBase58() === asset);
  return t ? `Balance ${units(t.amount, t.decimals)}` : '';
};

// Send is possible once the recipient now in the form passed the fee check.
const canSend = () => !state.busy && !!state.fee && state.fee.recipient === state.form.recipient.trim();

function sendView(): string {
  state.form.asset = currentAsset();
  return `
    <section class="view">
      <div class="amount-box">
        <input id="amount" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off" value="${escape(state.form.amount)}" />
        <select id="asset" class="asset">${assetOptions()}</select>
        <div id="balance" class="balance">${balanceLabel(state.form.asset)}</div>
      </div>
      <p id="token-note" class="token-note">${tokenNote(state.form.asset)}</p>
      <p id="fee-note" class="fee-note">${feeNote(state.form.asset)}</p>
      <label class="field"><span>To</span>
        <input id="recipient" autocomplete="off" spellcheck="false" placeholder="Recipient wallet address" value="${escape(state.form.recipient)}" />
      </label>
      <p id="recipient-check" class="check ${state.check?.cls ?? ''}">${state.check?.html ?? ''}</p>
      <p id="cost-note" class="cost-note"></p>
      <button id="send" class="pill primary big" ${canSend() ? '' : 'disabled'}>Safe Send</button>
      <div id="send-result"></div>
      <details class="how">
        <summary>How it works</summary>
        <ol>
          <li>Your funds are locked on-chain, not sent.</li>
          <li>The recipient claims them here, with the same wallet.</li>
          <li>Until then you can cancel and get everything back.</li>
        </ol>
      </details>
    </section>`;
}

function transferRow(t: PendingTransfer, kind: 'incoming' | 'sent'): string {
  const highlighted = state.highlight === t.address.toBase58() ? ' highlight' : '';
  const other = kind === 'incoming' ? t.sender : t.recipient;
  const who = `${kind === 'incoming' ? 'From' : 'To'} <a href="${explorer('address', other.toBase58())}" target="_blank" rel="noopener">${short(other)}</a>`;
  const disabled = state.busy ? 'disabled' : '';
  const action = kind === 'incoming'
    ? `<button class="pill primary" data-claim="${t.address.toBase58()}" ${disabled}>Claim</button>`
    : `<button class="pill ghost" data-cancel="${t.address.toBase58()}" ${disabled}>Cancel</button>`;
  return `
    <div class="item${highlighted}">
      <span class="icon ${kind === 'incoming' ? 'in' : 'out'}">${kind === 'incoming' ? '↓' : '↑'}</span>
      <div class="meta"><strong>${amountLabel(t)}</strong><span>${who} · ${date(t.createdAt)}</span></div>
      ${action}
    </div>`;
}

function listView(kind: 'incoming' | 'sent'): string {
  const list = kind === 'incoming' ? state.incoming : state.outgoing;
  if (!state.loaded) {
    return `<section class="view empty">
      <div class="empty-art">${state.loadError ? '⚠️' : '⏳'}</div>
      <p>${state.loadError ? 'Could not load transfers.' : 'Loading…'}</p>
      <div id="list-result"></div>
    </section>`;
  }
  if (list.length === 0) {
    return `<section class="view empty">
      <div class="empty-art">${kind === 'incoming' ? '📭' : '🕊️'}</div>
      <p>${kind === 'incoming' ? 'Nothing to claim yet.' : 'No pending transfers.'}</p>
      <span>${kind === 'incoming' ? 'Transfers sent to you with Safe Send show up here.' : 'Transfers wait here until the recipient claims them.'}</span>
      <div id="list-result"></div>
    </section>`;
  }
  const intro = kind === 'incoming'
    ? 'Claiming moves the funds to this wallet. It only costs the network fee.'
    : 'Waiting to be claimed. Cancel to take the funds back.';
  return `<section class="view"><p class="intro">${intro}</p>${list.map((t) => transferRow(t, kind)).join('')}<div id="list-result"></div></section>`;
}

// Draws the whole page from `state`. Synchronous: nothing on screen ever waits for the network.
function render(): void {
  if (!state.wallet) {
    app.innerHTML = `<div class="shell">${header()}${welcome()}</div>`;
  } else {
    const body = state.tab === 'send' ? sendView() : listView(state.tab);
    app.innerHTML = `<div class="shell">${header()}${walletNotice()}<div class="card">${tabs()}${status()}${body}</div></div>`;
    if (state.tab === 'send') void updateCost();
    const flash = state.flash?.tab === state.tab && document.getElementById(state.flash.target);
    if (flash) flash.innerHTML = `<div class="notice ${state.flash!.kind}">${state.flash!.html}</div>`;
  }
  bind(app);
}

// --- Actions ---

function message(target: Flash['target'], html: string, kind: Flash['kind'] = 'info'): void {
  state.flash = { tab: target === 'send-result' ? 'send' : state.tab, target, html, kind };
  const el = document.getElementById(target);
  if (!el) return;
  el.innerHTML = `<div class="notice ${kind}">${html}</div>`;
  bind(el);
}

function updateSendButton(): void {
  const button = document.getElementById('send') as HTMLButtonElement | null;
  if (button) button.disabled = !canSend();
  void updateCost(); // the recipient check changed
}

function showCheck(cls: string, html: string): void {
  state.check = html ? { cls, html } : null;
  const out = document.getElementById('recipient-check');
  if (out) {
    out.className = `check ${cls}`;
    out.innerHTML = html;
    bind(out);
  }
  updateSendButton();
}

let checkToken = 0;

async function checkRecipient(): Promise<void> {
  const text = state.form.recipient.trim();
  const token = ++checkToken;
  state.fee = null;
  if (!text) return showCheck('', '');
  let recipient: PublicKey;
  try { recipient = new PublicKey(text); } catch { return showCheck('error', 'Not a valid Solana address.'); }
  if (state.wallet && recipient.equals(state.wallet)) return showCheck('error', "That's your own wallet.");
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    return showCheck('error', "This address can't sign, so nobody could ever claim the transfer.");
  }
  showCheck('muted', 'Checking…');
  try {
    const check = await retry(() => checkRecipientFees(connection, recipient));
    if (token !== checkToken) return; // the address changed meanwhile
    state.fee = { recipient: text, check };
    showCheck(check.topUp ? 'warn' : 'ok', check.topUp
      ? `They don't have enough SOL for the claim fee, so we'll add <strong>${sol(check.topUp)} SOL</strong>. <span class="muted">Not refundable if the address is wrong.</span>`
      : '✓ The recipient can pay the claim fee.');
  } catch {
    if (token !== checkToken) return;
    showCheck('error', `Could not check this address: ${NETWORK_NAME} did not answer. <button class="link-button" data-recheck>Try again</button>`);
  }
}

async function send(): Promise<void> {
  if (!state.wallet || !canSend()) return;
  const sender = state.wallet;
  const { check } = state.fee!;
  const recipient = new PublicKey(state.fee!.recipient);
  const asset = currentAsset();
  const config = state.config;
  if (!config) return message('send-result', 'Still loading: try again in a moment.', 'error');
  const holding = asset === 'SOL' ? null : state.tokens.find((t) => t.mint.toBase58() === asset)!;
  const mint = holding && mintCache.get(asset);
  if (holding && !mint) return message('send-result', 'Token details are still loading: try again in a moment.', 'error');
  if (mint?.transferHook) return message('send-result', 'This token uses a transfer hook, which Safe Send does not support.', 'error');
  const amount = parseUnits(state.form.amount, holding ? holding.decimals : 9);
  if (amount === null) return message('send-result', 'Enter a valid amount, like 0.5.', 'error');
  if (amount <= 0n) return message('send-result', 'Enter an amount greater than zero.', 'error');
  if (holding && amount + percentFee(config, amount) > holding.amount) {
    return message('send-result', `You do not have that many tokens${config.feeBps ? ' (including the fee)' : ''}.`, 'error');
  }
  if (mint && transferFeeOf(mint, amount) >= amount) return message('send-result', "The token's transfer fee would take the whole amount: send more.", 'error');

  const id = newTransferId();
  const tx = new Transaction();
  if (check.topUp) tx.add(topUpIx(sender, recipient, check.topUp));
  if (holding && mint) tx.add(...sendTokenIxs({ sender, recipient, mint, senderToken: holding.account, id, amount, config }));
  else tx.add(sendSolIx({ sender, recipient, id, lamports: amount, config }));

  state.busy = true;
  updateSendButton();
  message('send-result', 'Preparing the transaction…');
  let signature: string;
  try {
    // Units measured by simulation and the current priority fee (also catches errors before Phantom opens)
    tx.instructions.unshift(...(await computeBudget(connection, tx.instructions, sender)).instructions);
    message('send-result', 'Confirm in Phantom…');
    signature = await signAndSend(connection, tx, sender);
  } catch (err) {
    state.busy = false;
    if (state.wallet?.equals(sender)) {
      message('send-result', describeError(err), 'error');
      updateSendButton();
    }
    return;
  }
  state.busy = false;
  if (!state.wallet?.equals(sender)) return; // the user switched wallet meanwhile
  const link = `${location.origin}${location.pathname}?transfer=${escrowAddress(sender, id).toBase58()}`;
  const own = connectedWallets().includes(recipient.toBase58());
  Object.assign(state, { form: emptyForm(asset), fee: null, check: null });
  accountExists.clear(); // the send may have created token accounts
  state.flash = { tab: 'send', target: 'send-result', kind: 'ok', html: `
    <strong>Locked and on its way.</strong> It arrives when the recipient claims it.
    ${check.topUp ? `<br/>Included ${sol(check.topUp)} SOL so they can pay the claim fee.` : ''}
    <br/>Send them this link: <input class="link" readonly value="${escape(link)}" onclick="this.select()" />
    <a href="${explorer('tx', signature)}" target="_blank" rel="noopener">View transaction ↗</a>
    <div class="own-wallet">${own
      ? `It's one of your wallets: <button class="link-button" data-use="${recipient.toBase58()}">switch to ${short(recipient)} to claim it</button>`
      : `Sent to another of your wallets? <button class="link-button" data-add>Connect it to claim</button>`}</div>` };
  if (state.tab === 'send') render();
  void refresh(true); // new balance and pending count
}

async function act(kind: 'claim' | 'cancel', address: string): Promise<void> {
  if (!state.wallet || state.busy) return;
  const list = kind === 'claim' ? state.incoming : state.outgoing;
  const t = list.find((x) => x.address.toBase58() === address);
  if (!t) return;
  const me = state.wallet;
  const mint = t.isSol ? null : mintCache.get(t.mint.toBase58());
  if (!t.isSol && !mint) return; // loaded with the transfers
  const tx = new Transaction().add(kind === 'claim'
    ? (mint ? claimTokenIx({ recipient: me, sender: t.sender, mint, escrow: t.address }) : claimSolIx({ recipient: me, sender: t.sender, escrow: t.address }))
    : (mint ? cancelTokenIx({ sender: me, mint, escrow: t.address }) : cancelSolIx({ sender: me, escrow: t.address })));
  state.busy = true;
  const tab = state.tab;
  state.flash = { tab, target: 'list-result', kind: 'info', html: 'Preparing the transaction…' };
  render(); // buttons disabled while waiting
  try {
    // A claim's priority fee stays within what the recipient can pay (e.g. only the sender's top-up)
    const cap = kind === 'claim' ? await claimPriorityCap(connection, me) : MAX_PRIORITY_LAMPORTS;
    tx.instructions.unshift(...(await computeBudget(connection, tx.instructions, me, cap)).instructions);
    message('list-result', 'Confirm in Phantom…');
    const signature = await signAndSend(connection, tx, me);
    state.busy = false;
    closed.add(address);
    if (!state.wallet?.equals(me)) return; // the user switched wallet meanwhile
    state.incoming = state.incoming.filter((x) => x.address.toBase58() !== address);
    state.outgoing = state.outgoing.filter((x) => x.address.toBase58() !== address);
    state.flash = { tab, target: 'list-result', kind: 'ok', html: `${kind === 'claim' ? `<strong>Claimed.</strong> ${amountLabel(t)} received.` : `<strong>Cancelled.</strong> ${amountLabel(t)} is back in your wallet.`}
      <a href="${explorer('tx', signature)}" target="_blank" rel="noopener">View transaction ↗</a>` };
    render();
    void refresh(true);
  } catch (err) {
    state.busy = false;
    if (!state.wallet?.equals(me)) return;
    state.flash = { tab, target: 'list-result', kind: 'error', html: describeError(err) };
    render();
  }
}

function showTab(tab: Tab): void {
  state.tab = tab;
  render(); // right away, with the data already loaded
  if (Date.now() - lastRefresh > TAB_REFRESH_MS) void refresh();
}

function toggleMenu(open: boolean): void {
  state.menu = open;
  replace('.top', header());
}

// Binds the buttons inside `root` (the whole page, or a part that was just replaced).
function bind(root: ParentNode): void {
  const on = (selector: string, handler: (el: HTMLElement, event: Event) => void, event = 'click') =>
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => el.addEventListener(event, (e) => handler(el, e)));
  // A replaced element is itself the root: match it too.
  const self = (selector: string, handler: (el: HTMLElement, event: Event) => void) => {
    if (root instanceof HTMLElement && root.matches(selector)) root.addEventListener('click', (e) => handler(root, e));
  };

  on('[data-connect]', () => void connectNew());
  on('[data-use]', (el) => void useWallet(el.dataset.use!));
  on('[data-add]', () => { Object.assign(state, { notice: { kind: 'add' }, menu: false, pending: null }); render(); });
  on('[data-cancel-switch]', () => { state.pending = null; render(); });
  on('[data-menu]', (_, event) => { event.stopPropagation(); toggleMenu(!state.menu); });
  on('[data-copy]', async (el) => {
    await navigator.clipboard.writeText(state.wallet!.toBase58()).catch(() => {});
    el.textContent = 'Copied ✓';
  });
  on('[data-disconnect]', () => void disconnectActive());
  on('[data-tab]', (el) => showTab(el.dataset.tab as Tab));
  self('[data-tab]', (el) => showTab(el.dataset.tab as Tab));
  on('[data-retry]', () => { state.loadError = false; paint(); void refresh(true); });
  on('[data-recheck]', () => void checkRecipient());
  on('[data-claim]', (el) => void act('claim', el.dataset.claim!));
  on('[data-cancel]', (el) => void act('cancel', el.dataset.cancel!));
  on('#send', () => void send());
  on('#amount', (el) => {
    state.form.amount = (el as HTMLInputElement).value;
    document.getElementById('fee-note')!.textContent = feeNote(state.form.asset);
    void updateCost();
  }, 'input');
  on('#asset', (el) => {
    state.form.asset = (el as HTMLSelectElement).value;
    document.getElementById('balance')!.textContent = balanceLabel(state.form.asset);
    document.getElementById('token-note')!.innerHTML = tokenNote(state.form.asset);
    document.getElementById('fee-note')!.textContent = feeNote(state.form.asset);
    void updateCost();
  }, 'change');
  on('#recipient', (el) => {
    state.form.recipient = (el as HTMLInputElement).value;
    // The old check no longer applies: Send waits for the new one.
    state.fee = null;
    checkToken++;
    showCheck('', '');
    clearTimeout(recipientTimer);
    recipientTimer = window.setTimeout(checkRecipient, 350);
  }, 'input');
}

let recipientTimer: number | undefined;

// --- Wallets ---

// Makes a connected wallet the active one (Phantom must have it selected, see useWallet).
function activate(wallet: string): void {
  if (state.wallet?.toBase58() !== wallet) {
    clearWallet();
    state.wallet = new PublicKey(wallet);
  }
  Object.assign(state, { menu: false, pending: null, notice: null });
  render();
  void refresh();
}

function clearWallet(): void {
  refreshSeq++; // drop loads still running for the previous wallet
  inFlight = null;
  reloadAfter = false;
  checkToken++;
  Object.assign(state, {
    wallet: null, loaded: false, loadError: false, menu: false, tab: 'send', incoming: [], outgoing: [], tokens: [], sol: 0,
    form: emptyForm(), fee: null, check: null, flash: null, highlightShown: false,
  });
}

// Picked from the list: switch now if Phantom has that account selected, otherwise ask to select it there.
async function useWallet(wallet: string): Promise<void> {
  if ((await selectedAccount())?.toBase58() === wallet) return activate(wallet);
  Object.assign(state, { pending: wallet, menu: false, notice: null });
  render();
}

let connecting = false;
async function connectNew(): Promise<void> {
  if (!phantom()) { window.open('https://phantom.com/', '_blank', 'noopener'); return; }
  if (connecting) return; // Phantom is already asking
  connecting = true;
  try {
    // A signature for the first connection and to bring back a wallet the user disconnected; otherwise
    // approving another account in Phantom is enough.
    const selected = (await selectedAccount())?.toBase58();
    const needsSignature = connectedWallets().length === 0 || (!!selected && isDisconnected(selected));
    const wallet = needsSignature ? await connectWithSignature() : await approveAccount();
    if (wallet && state.notice?.kind === 'add' && state.wallet?.equals(wallet)) {
      // Adding a wallet, but Phantom still has the active one selected
      state.notice = { kind: 'add', stillSelected: wallet.toBase58() };
      render();
    } else if (wallet) {
      activate(wallet.toBase58());
    }
  } finally {
    connecting = false;
  }
}

// Disconnects the active wallet only: the others stay connected and can be selected in Phantom. The
// disconnected one needs a new signature to come back.
async function disconnectActive(): Promise<void> {
  if (!state.wallet) return;
  const wallet = state.wallet.toBase58();
  const done = disconnectWallet(wallet); // updates the lists right away, before the page re-renders
  clearWallet();
  Object.assign(state, { pending: null, notice: connectedWallets().length ? { kind: 'not-connected', account: wallet } : null });
  render();
  await done;
}

// Close the wallet menu when clicking anywhere else.
document.addEventListener('click', (event) => {
  if (state.menu && !(event.target as HTMLElement).closest('.wallet-wrap')) toggleMenu(false);
});

// --- Start ---

// The user selected another account in Phantom: Safe Send follows it. Phantom shares the address only if that
// account already approved the site; for a new account, Phantom's connect popup opens to approve it.
let approving = false;
phantom()?.on('accountChanged', async (key) => {
  if (connectedWallets().length === 0) return; // disconnected: wait for "Connect Phantom"
  if (key) {
    const account = key.toString();
    if (isDisconnected(account)) {
      clearWallet();
      Object.assign(state, { pending: null, notice: { kind: 'not-connected', account } });
      return render();
    }
    rememberWallet(account);
    return activate(account);
  }
  if (approving) return;
  approving = true;
  try {
    const account = await approveAccount();
    if (account) {
      activate(account.toBase58());
    } else {
      clearWallet();
      Object.assign(state, { pending: null, notice: { kind: 'not-connected', account: null } });
      render();
    }
  } finally {
    approving = false;
  }
});

// Back on the page (e.g. after using Phantom's side panel or popup): if Phantom now has another connected wallet
// selected, switch to it. Phantom does not always send accountChanged, so this checks directly.
let following = false;
async function followSelected(): Promise<void> {
  if (!state.wallet || connecting || approving || state.busy || following) return;
  following = true;
  try {
    const selected = (await selectedAccount())?.toBase58();
    if (selected && selected !== state.wallet?.toBase58() && connectedWallets().includes(selected) && !isDisconnected(selected)) {
      activate(selected);
    }
  } finally {
    following = false;
  }
}
window.addEventListener('focus', () => void followSelected());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void followSelected(); });

// While the page is visible, keep watching Phantom so a switch made in its side panel shows up within a second,
// without a click. Both checks talk only to the extension (no RPC): every 0.5 s the account Phantom exposes on
// the page, and every 1.5 s, in case that is not updated, the account it has selected.
const watching = () => document.visibilityState === 'visible' && !!state.wallet;
setInterval(() => {
  const exposed = phantom()?.publicKey?.toString();
  if (watching() && exposed && exposed !== state.wallet?.toBase58()) void followSelected();
}, 500);
setInterval(() => { if (watching()) void followSelected(); }, 1_500);

render();
// Back on the page: resume with the account selected in Phantom, unless the user disconnected.
void selectedAccount().then((selected) => {
  if (!selected || state.wallet || connectedWallets().length === 0) return;
  const account = selected.toBase58();
  if (isDisconnected(account)) {
    Object.assign(state, { notice: { kind: 'not-connected', account } });
    return render();
  }
  rememberWallet(account);
  activate(account);
});

