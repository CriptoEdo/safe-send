import './polyfills.ts';
import './style.css';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import {
  cancelSolIx, cancelTokenIx, checkRecipientFees, claimFeeIxs, claimSolIx, claimTokenIx, escrowAddress, incomingTransfers,
  newTransferId, outgoingTransfers, sendSolIx, sendTokenIxs, topUpIx, type FeeCheck, type PendingTransfer,
} from './lib/safeSend.ts';
import { connectWithSignature, connectedWallets, disconnectWallet, phantom, selectedAccount, signAndSend } from './wallet.ts';

const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');
const app = document.getElementById('app')!;

type Tab = 'send' | 'incoming' | 'sent';
interface TokenHolding { mint: PublicKey; account: PublicKey; amount: bigint; decimals: number }

const state = {
  wallet: null as PublicKey | null,
  sol: 0,
  tokens: [] as TokenHolding[],
  incoming: [] as PendingTransfer[],
  outgoing: [] as PendingTransfer[],
  tab: 'send' as Tab,
  highlight: new URLSearchParams(location.search).get('transfer'),
  busy: false,
  menu: false, // wallet menu open
  // A connected wallet the user picked, waiting for them to select it in Phantom (Phantom signs with its own
  // selected account, a website cannot change it).
  pending: null as string | null,
  // Shown above the content: how to add a wallet, or the account selected in Phantom is not connected here.
  notice: null as null | { kind: 'add' } | { kind: 'not-connected'; account: string | null },
};

// --- Formatting ---

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const explorer = (kind: 'tx' | 'address', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
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

const decimalsCache = new Map<string, number>();
async function decimalsOf(mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  if (!decimalsCache.has(key)) decimalsCache.set(key, (await getMint(connection, mint)).decimals);
  return decimalsCache.get(key)!;
}

async function amountLabel(t: PendingTransfer): Promise<string> {
  if (t.isSol) return `${sol(t.amount)} SOL`;
  return `${units(t.amount, await decimalsOf(t.mint))} <span class="mint" title="${t.mint.toBase58()}">${short(t.mint)}</span>`;
}

// Program errors (Anchor custom errors start at 6000) and wallet rejections, in plain words.
function describeError(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  if (/User rejected|rejected the request/i.test(text)) return 'You rejected the request in Phantom.';
  const logs = err instanceof SendTransactionError ? (err.logs ?? []).join('\n') : text;
  const anchor = /Error Message: ([^.\n]+)/.exec(logs);
  if (anchor) return `${anchor[1]}.`;
  if (/insufficient (funds|lamports)|0x1\b/i.test(logs)) return 'Not enough SOL for this transaction (amount + fees).';
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

// --- Data ---

async function refresh(): Promise<void> {
  if (!state.wallet) return;
  const owner = state.wallet;
  const [lamports, parsed, incoming, outgoing] = await Promise.all([
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    incomingTransfers(connection, owner),
    outgoingTransfers(connection, owner),
  ]);
  state.sol = lamports;
  state.tokens = parsed.value
    .map(({ pubkey, account }) => {
      const info = account.data.parsed.info;
      return { mint: new PublicKey(info.mint), account: pubkey, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals };
    })
    .filter((t) => t.amount > 0n);
  state.incoming = incoming;
  state.outgoing = outgoing;
  if (state.highlight && incoming.some((t) => t.address.toBase58() === state.highlight)) state.tab = 'incoming';
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
          <div class="menu-head"><span class="muted">Active wallet</span><code>${short(state.wallet)}</code><span class="muted">${sol(state.sol)} SOL</span></div>
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
      <div class="brand"><span class="logo">${SHIELD}</span>Safe Send<span class="chip">Devnet</span></div>
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
    return `<div class="switch-hint">
      <strong>Add another wallet</strong>
      Select the new account in Phantom, then connect it here with a signature.
      <button class="pill primary small" data-connect>Connect &amp; sign</button>
    </div>`;
  }
  if (state.notice?.kind === 'not-connected') {
    return `<div class="switch-hint">
      <strong>${state.notice.account ? `${short(state.notice.account)} is not connected` : 'This Phantom account is not connected'}</strong>
      Connect it with a signature to use it here${connectedWallets().length ? ', or pick one of your wallets' : ''}.
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
      <p class="hint">Connecting asks for a free signature. Use Devnet: Phantom → Settings → Developer settings → Testnet mode</p>
    </section>`;
}

function tabs(): string {
  const tab = (id: Tab, label: string, count?: number) =>
    `<button class="seg ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`;
  return `<nav class="segments">${tab('send', 'Send')}${tab('incoming', 'Receive', state.incoming.length)}${tab('sent', 'Pending', state.outgoing.length)}</nav>`;
}

const balanceLabel = (asset: string) => {
  if (asset === 'SOL') return `Balance ${sol(state.sol)} SOL`;
  const t = state.tokens.find((x) => x.mint.toBase58() === asset);
  return t ? `Balance ${units(t.amount, t.decimals)}` : '';
};

function sendView(): string {
  const options = [`<option value="SOL">SOL</option>`]
    .concat(state.tokens.map((t) => `<option value="${t.mint.toBase58()}">${short(t.mint)}</option>`))
    .join('');
  return `
    <section class="view">
      <div class="amount-box">
        <input id="amount" class="amount-input" inputmode="decimal" placeholder="0" autocomplete="off" />
        <select id="asset" class="asset">${options}</select>
        <div id="balance" class="balance">${balanceLabel('SOL')}</div>
      </div>
      <label class="field"><span>To</span>
        <input id="recipient" autocomplete="off" spellcheck="false" placeholder="Recipient wallet address" />
      </label>
      <p id="recipient-check" class="check"></p>
      <button id="send" class="pill primary big" disabled>Safe Send</button>
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

async function transferRow(t: PendingTransfer, kind: 'incoming' | 'sent'): Promise<string> {
  const amount = await amountLabel(t);
  const highlighted = state.highlight === t.address.toBase58() ? ' highlight' : '';
  const other = kind === 'incoming' ? t.sender : t.recipient;
  const who = `${kind === 'incoming' ? 'From' : 'To'} <a href="${explorer('address', other.toBase58())}" target="_blank" rel="noopener">${short(other)}</a>`;
  const action = kind === 'incoming'
    ? `<button class="pill primary" data-claim="${t.address.toBase58()}">Claim</button>`
    : `<button class="pill ghost" data-cancel="${t.address.toBase58()}">Cancel</button>`;
  return `
    <div class="item${highlighted}">
      <span class="icon ${kind === 'incoming' ? 'in' : 'out'}">${kind === 'incoming' ? '↓' : '↑'}</span>
      <div class="meta"><strong>${amount}</strong><span>${who} · ${date(t.createdAt)}</span></div>
      ${action}
    </div>`;
}

async function listView(kind: 'incoming' | 'sent'): Promise<string> {
  const list = kind === 'incoming' ? state.incoming : state.outgoing;
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
  return `<section class="view"><p class="intro">${intro}</p>${(await Promise.all(list.map((t) => transferRow(t, kind)))).join('')}<div id="list-result"></div></section>`;
}

async function render(): Promise<void> {
  if (!state.wallet) {
    app.innerHTML = `<div class="shell">${header()}${welcome()}</div>`;
  } else {
    const body = state.tab === 'send' ? sendView() : await listView(state.tab === 'incoming' ? 'incoming' : 'sent');
    app.innerHTML = `<div class="shell">${header()}${walletNotice()}<div class="card">${tabs()}${body}</div></div>`;
  }
  bind();
}

// --- Actions ---

function message(target: string, html: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const el = document.getElementById(target);
  if (el) el.innerHTML = `<div class="notice ${kind}">${html}</div>`;
}

let feeCheck: FeeCheck | null = null;
let checkToken = 0;

async function checkRecipient(): Promise<void> {
  const input = document.getElementById('recipient') as HTMLInputElement;
  const out = document.getElementById('recipient-check')!;
  const button = document.getElementById('send') as HTMLButtonElement;
  feeCheck = null;
  button.disabled = true;
  const text = input.value.trim();
  if (!text) { out.className = 'check'; out.textContent = ''; return; }
  let recipient: PublicKey;
  try { recipient = new PublicKey(text); } catch { out.className = 'check error'; out.textContent = 'Not a valid Solana address.'; return; }
  if (state.wallet && recipient.equals(state.wallet)) { out.className = 'check error'; out.textContent = "That's your own wallet."; return; }
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    out.className = 'check error';
    out.textContent = "This address can't sign, so nobody could ever claim the transfer.";
    return;
  }
  const token = ++checkToken;
  out.className = 'check muted';
  out.textContent = 'Checking…';
  const check = await checkRecipientFees(connection, recipient);
  if (token !== checkToken) return; // the input changed meanwhile
  feeCheck = check;
  out.className = check.topUp ? 'check warn' : 'check ok';
  out.innerHTML = check.topUp
    ? `They don't have enough SOL for the claim fee, so we'll add <strong>${sol(check.topUp)} SOL</strong>. <span class="muted">Not refundable if the address is wrong.</span>`
    : '✓ The recipient can pay the claim fee.';
  button.disabled = false;
}

async function send(): Promise<void> {
  if (!state.wallet || !feeCheck || state.busy) return;
  const sender = state.wallet;
  const recipient = new PublicKey((document.getElementById('recipient') as HTMLInputElement).value.trim());
  const asset = (document.getElementById('asset') as HTMLSelectElement).value;
  const amountText = (document.getElementById('amount') as HTMLInputElement).value;
  const holding = asset === 'SOL' ? null : state.tokens.find((t) => t.mint.toBase58() === asset)!;
  const amount = parseUnits(amountText, holding ? holding.decimals : 9);
  if (!amount || amount <= 0n) return message('send-result', 'Enter an amount greater than zero.', 'error');
  if (holding && amount > holding.amount) return message('send-result', 'You do not have that many tokens.', 'error');

  const id = newTransferId();
  const tx = new Transaction();
  if (feeCheck.topUp) tx.add(topUpIx(sender, recipient, feeCheck.topUp));
  if (holding) tx.add(...sendTokenIxs({ sender, recipient, mint: holding.mint, senderToken: holding.account, id, amount }));
  else tx.add(sendSolIx({ sender, recipient, id, lamports: amount }));

  state.busy = true;
  (document.getElementById('send') as HTMLButtonElement).disabled = true;
  message('send-result', 'Confirm in Phantom…');
  try {
    const signature = await signAndSend(connection, tx, sender);
    const escrow = escrowAddress(sender, id);
    const link = `${location.origin}${location.pathname}?transfer=${escrow.toBase58()}`;
    await refresh();
    await render(); // updated balances and pending count
    message('send-result', `
      <strong>Locked and on its way.</strong> It arrives when the recipient claims it.
      ${feeCheck.topUp ? `<br/>Included ${sol(feeCheck.topUp)} SOL so they can pay the claim fee.` : ''}
      <br/>Send them this link: <input class="link" readonly value="${escape(link)}" onclick="this.select()" />
      <a href="${explorer('tx', signature)}" target="_blank" rel="noopener">View transaction ↗</a>
      <div class="own-wallet">${connectedWallets().includes(recipient.toBase58())
        ? `It's one of your wallets: <button class="link-button" data-use="${recipient.toBase58()}">switch to ${short(recipient)} to claim it</button>`
        : `Sent to another of your wallets? <button class="link-button" data-add>Connect it to claim</button>`}</div>`, 'ok');
    bindWallets();
  } catch (err) {
    message('send-result', describeError(err), 'error');
  } finally {
    state.busy = false;
    (document.getElementById('send') as HTMLButtonElement | null)?.removeAttribute('disabled');
  }
}

async function act(kind: 'claim' | 'cancel', address: string): Promise<void> {
  if (!state.wallet || state.busy) return;
  const list = kind === 'claim' ? state.incoming : state.outgoing;
  const t = list.find((x) => x.address.toBase58() === address);
  if (!t) return;
  const me = state.wallet;
  const tx = new Transaction().add(...claimFeeIxs(), kind === 'claim'
    ? (t.isSol ? claimSolIx({ recipient: me, sender: t.sender, escrow: t.address }) : claimTokenIx({ recipient: me, sender: t.sender, mint: t.mint, escrow: t.address }))
    : (t.isSol ? cancelSolIx({ sender: me, escrow: t.address }) : cancelTokenIx({ sender: me, mint: t.mint, escrow: t.address })));
  state.busy = true;
  document.querySelectorAll<HTMLButtonElement>('[data-claim], [data-cancel]').forEach((b) => { b.disabled = true; });
  message('list-result', 'Confirm in Phantom…');
  try {
    const signature = await signAndSend(connection, tx, me);
    const label = await amountLabel(t);
    await refresh();
    await render();
    message('list-result', `${kind === 'claim' ? `<strong>Claimed.</strong> ${label} received.` : `<strong>Cancelled.</strong> ${label} is back in your wallet.`}
      <a href="${explorer('tx', signature)}" target="_blank" rel="noopener">View transaction ↗</a>`, 'ok');
  } catch (err) {
    message('list-result', describeError(err), 'error');
    document.querySelectorAll<HTMLButtonElement>('[data-claim], [data-cancel]').forEach((b) => { b.disabled = false; });
  } finally {
    state.busy = false;
  }
}

function bind(): void {
  bindWallets();
  document.querySelector('[data-menu]')?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.menu = !state.menu;
    void render();
  });
  document.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(state.wallet!.toBase58()).catch(() => {});
    button.textContent = 'Copied ✓';
  });
  document.querySelector('[data-disconnect]')?.addEventListener('click', disconnectActive);
  const asset = document.getElementById('asset') as HTMLSelectElement | null;
  asset?.addEventListener('change', () => { document.getElementById('balance')!.textContent = balanceLabel(asset.value); });
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    state.tab = b.dataset.tab as Tab;
    await refresh();
    await render();
  }));
  const recipient = document.getElementById('recipient');
  if (recipient) {
    let timer: number | undefined;
    recipient.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(checkRecipient, 350); });
    document.getElementById('send')!.addEventListener('click', send);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((b) => b.addEventListener('click', () => act('claim', b.dataset.claim!)));
  document.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) => b.addEventListener('click', () => act('cancel', b.dataset.cancel!)));
}

// --- Wallets ---

// Makes a connected wallet the active one (Phantom must have it selected, see useWallet).
async function activate(wallet: string): Promise<void> {
  Object.assign(state, { wallet: new PublicKey(wallet), menu: false, pending: null, notice: null, tab: 'send' });
  await refresh();
  await render();
}

function clearWallet(): void {
  Object.assign(state, { wallet: null, menu: false, tab: 'send', incoming: [], outgoing: [], tokens: [], sol: 0 });
}

// Picked from the list: switch now if Phantom has that account selected, otherwise ask to select it there.
async function useWallet(wallet: string): Promise<void> {
  if ((await selectedAccount())?.toBase58() === wallet) return activate(wallet);
  Object.assign(state, { pending: wallet, menu: false, notice: null });
  await render();
}

async function connectNew(): Promise<void> {
  if (!phantom()) { window.open('https://phantom.com/', '_blank', 'noopener'); return; }
  const wallet = await connectWithSignature();
  if (wallet) await activate(wallet.toBase58());
}

// Removes the active wallet from the connected list: selecting it again in Phantom will not reconnect it,
// it needs a new signature. The other connected wallets stay available.
async function disconnectActive(): Promise<void> {
  if (!state.wallet) return;
  await disconnectWallet(state.wallet);
  clearWallet();
  Object.assign(state, { pending: null, notice: null });
  await render();
}

function bindWallets(): void {
  document.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', connectNew));
  document.querySelectorAll<HTMLButtonElement>('[data-use]').forEach((b) => b.addEventListener('click', () => useWallet(b.dataset.use!)));
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    Object.assign(state, { notice: { kind: 'add' }, menu: false, pending: null });
    void render();
  }));
  document.querySelector('[data-cancel-switch]')?.addEventListener('click', () => {
    state.pending = null;
    void render();
  });
}

// Close the wallet menu when clicking anywhere else.
document.addEventListener('click', (event) => {
  if (state.menu && !(event.target as HTMLElement).closest('.wallet-wrap')) {
    state.menu = false;
    void render();
  }
});

// --- Start ---

// The user selected another account in Phantom. Follow it only if it is one of the connected wallets; any other
// account (including one the user disconnected) needs a new signature first.
phantom()?.on('accountChanged', async (key) => {
  const account = key ? key.toString() : null;
  if (account && connectedWallets().includes(account)) return activate(account);
  clearWallet();
  Object.assign(state, { pending: null, notice: { kind: 'not-connected', account } });
  await render();
});

(async () => {
  await render();
  // Back on the page: resume only if the account selected in Phantom is one of the connected wallets.
  const selected = (await selectedAccount())?.toBase58();
  if (selected && connectedWallets().includes(selected)) await activate(selected);
})();
