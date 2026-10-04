// End-to-end UI suite, run in the harness page against a local validator:
//   await harness.setup(2); location.reload();   then   await runSuite()
// Each step drives the real UI (clicks, typing) and checks the screen and the chain. Returns pass/fail per check.
const h = (window as any).harness;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (s: string) => document.querySelector<HTMLElement>(`#app ${s}`);
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(`#app ${s}`)];
const text = (s = '') => ((s ? $(s) : document.getElementById('app'))?.innerText ?? '').replace(/\s+/g, ' ');
const tab = () => $('.seg.active')?.dataset.tab;
const rpcRequests = () => performance.getEntriesByType('resource').filter((e) => e.name.includes(':8899')).length;
// The SOL total and the network fee in the cost note ("You pay about X SOL. … about Y SOL is the network fee").
const shownCost = (pattern: RegExp) => {
  const note = text('#cost-note');
  const lamports = (re: RegExp) => Math.round(Number(re.exec(note)![1]) * 1e9);
  return { total: lamports(pattern), network: lamports(/about ([\d.]+) SOL is the network fee/) };
};
// Only the network fee is an estimate (compute units are measured when sending).
const costMatches = (charged: number, shown: { total: number; network: number }) =>
  Math.abs(charged - shown.total) <= Math.max(20_000, shown.network / 2);
const click = (s: string) => { const el = $(s); if (!el) throw new Error(`missing ${s}`); el.click(); };
const type = (s: string, v: string) => { const el = $(s) as HTMLInputElement; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const pick = (s: string, v: string) => { const el = $(s) as HTMLSelectElement; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
async function until<T>(fn: () => T, what: string, ms = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const v = fn(); if (v) return v; } catch { /* not yet */ }
    await wait(100);
  }
  throw new Error(`timeout: ${what} | ${text().slice(0, 300)}`);
}

(window as any).runSuite = async () => {
  const results: [string, boolean, string?][] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, ok ? undefined : detail]);
  const A = h.address(0), B = h.address(1);
  try {
    // Connect with a signature
    click('[data-connect]');
    await until(() => $('.wallet'), 'connected');
    check('connect asks one signature', h.controls.messages === 1, String(h.controls.messages));
    // Phantom repeating accountChanged for the same account while loading must not restart the load forever
    for (let i = 0; i < 20; i++) { h.select(0); await wait(100); }
    await until(() => text('#balance').includes('2 SOL'), 'balance despite repeated accountChanged', 10_000);
    check('loads despite repeated accountChanged', true);

    // Tabs switch instantly, many times, stay where clicked, and do not flood the RPC
    await wait(1000);
    const requests = rpcRequests();
    let tabsOk = true;
    for (let i = 0; i < 5; i++) {
      for (const t of ['incoming', 'sent', 'send', 'sent', 'incoming', 'send', 'incoming', 'sent']) { click(`[data-tab="${t}"]`); tabsOk &&= tab() === t; }
    }
    await wait(1500);
    check('rapid tab switching', tabsOk && tab() === 'sent', String(tab()));
    check('40 tab clicks make no RPC requests', rpcRequests() === requests, String(rpcRequests() - requests));
    click('[data-tab="send"]');

    // Form validation and state kept across menu / tabs
    type('#amount', '0.5'); type('#recipient', B);
    check('send waits for the recipient check', ($('#send') as HTMLButtonElement).disabled);
    await until(() => $('#recipient-check')!.className.includes('ok'), 'recipient check');
    click('[data-menu]'); await wait(50); document.body.click(); await wait(50);
    click('[data-tab="sent"]'); click('[data-tab="send"]');
    check('form kept across menu and tabs', ($('#amount') as HTMLInputElement).value === '0.5' && ($('#recipient') as HTMLInputElement).value === B && !($('#send') as HTMLButtonElement).disabled);
    for (const [v, expected] of [['abc', 'valid amount'], ['0', 'greater than zero'], ['0.0000000001', 'valid amount']]) {
      type('#amount', v); click('#send');
      check(`amount "${v}" rejected`, text('#send-result').includes(expected), text('#send-result'));
    }
    type('#amount', '5'); click('#send');
    await until(() => $('#send-result .error'), 'too much SOL');
    check('more SOL than the balance: clear error', text('#send-result').includes('Not enough SOL'), text('#send-result'));
    type('#recipient', 'not-an-address'); await wait(500);
    check('invalid address', text('#recipient-check').includes('Not a valid'), text('#recipient-check'));
    type('#recipient', A); await wait(500);
    check('own address', text('#recipient-check').includes('your own'), text('#recipient-check'));
    type('#recipient', B); await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B');

    // Rejected in Phantom
    h.controls.rejectNext = true; type('#amount', '0.5'); click('#send');
    await until(() => $('#send-result .error'), 'rejection');
    check('rejection shown, send re-enabled', text('#send-result').includes('rejected') && !($('#send') as HTMLButtonElement).disabled);

    // The cost shown before signing matches what leaves the wallet (plus the network fee)
    type('#amount', '0.5');
    await until(() => text('#cost-note').includes('You pay'), 'cost shown');
    const shown = shownCost(/You pay about ([\d.]+) SOL/);
    const balanceBefore = await h.balance(0);

    // Send SOL (double click sends once)
    const signs = h.controls.signs;
    click('#send'); click('#send');
    await until(() => $('#send-result .ok'), 'sent');
    check('send once on double click', h.controls.signs === signs + 1, String(h.controls.signs - signs));
    check('form cleared after send', ($('#amount') as HTMLInputElement).value === '' && ($('#recipient') as HTMLInputElement).value === '');
    await until(() => text('.segments').includes('Pending 1'), 'pending count');
    const charged = balanceBefore - (await h.balance(0));
    check('cost shown = amount charged (network fee estimated)', costMatches(charged, shown), `shown ${JSON.stringify(shown)}, charged ${charged}`);

    // Fees on: the app shows the fee before sending and the treasury receives it
    const treasury = await h.setFees(30, 0.001); // 0.3% + 0.001 SOL
    await wait(21_000); // the config reloads with the wallet's data (tabs reload at most every 20 s)
    click('[data-tab="incoming"]'); click('[data-tab="send"]');
    type('#amount', '1');
    await until(() => text('#fee-note').includes('0.003 SOL (0.3%)') && text('#fee-note').includes('0.001 SOL'), 'fee shown');
    check('fee shown before sending', true);
    type('#recipient', B);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B fee');
    const treasuryBefore = await h.connection.getBalance(new h.PublicKey(treasury));
    click('#send');
    await until(() => $('#send-result .ok, #send-result .error'), 'sent with fee');
    check('send with fee', !!$('#send-result .ok'), text('#send-result'));
    check('treasury received 0.004 SOL', (await h.connection.getBalance(new h.PublicKey(treasury))) - treasuryBefore === 4_000_000);
    await h.setFees(0);
    await wait(21_000);
    click('[data-tab="sent"]'); click('[data-tab="send"]');
    await until(() => text('#fee-note') === '', 'fee hidden again');
    check('no fee: nothing shown', true);
    click('[data-tab="sent"]');
    await until(() => $('[data-cancel]'), 'pending listed');
    while ($('[data-cancel]') && $$('[data-cancel]').length > 1) { // keep only the first send for the cancel check
      const last = $$('[data-cancel]').at(-1)!; last.click();
      await until(() => $('#list-result .ok, #list-result .error'), 'cancel extra'); await wait(300);
    }
    click('[data-tab="send"]');

    // Cancel and refund
    click('[data-tab="sent"]');
    const before = await h.balance(0);
    click('[data-cancel]');
    await until(() => $('#list-result .ok'), 'cancel');
    const refund = (await h.balance(0)) - before;
    check('cancel refunds amount + rent', refund > 0.5e9, String(refund));
    await wait(1500);
    check('cancelled transfer stays gone', !text('.segments').includes('Pending 1'), text('.segments'));

    // Tokens: an SPL token and a Token-2022 token with a 1% transfer fee to B, a hook token refused; then B claims
    const mint = await h.mintTokens(0, 100);
    const feeMint = await h.mintToken2022(0, 50, { feeBasisPoints: 100 });
    const hookMint = await h.mintToken2022(0, 5, { hook: true });
    await wait(21_000); // tabs reload from the network at most every 20 s
    click('[data-tab="incoming"]'); click('[data-tab="send"]');
    await until(() => [mint, feeMint, hookMint].every((m) => [...($('#asset') as HTMLSelectElement).options].some((o) => o.value === m)), 'tokens listed');
    pick('#asset', mint);
    check('token balance', text('#balance').includes('100'), text('#balance'));
    check('no note for a plain token', text('#token-note') === '', text('#token-note'));
    type('#amount', '7.25'); type('#recipient', B);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B token');
    await until(() => text('#cost-note').includes('token account for the recipient'), 'token cost shown');
    const tokenShown = shownCost(/\+ ([\d.]+) SOL/);
    const solBeforeToken = await h.balance(0);
    click('#send');
    await until(() => $('#send-result .ok'), 'token sent');
    const tokenCharged = solBeforeToken - (await h.balance(0));
    check('token send: SOL shown = SOL charged (network fee estimated)', costMatches(tokenCharged, tokenShown), `shown ${JSON.stringify(tokenShown)}, charged ${tokenCharged}`);

    pick('#asset', hookMint);
    check('hook token: warned', text('#token-note').includes('transfer hook'), text('#token-note'));
    type('#amount', '1'); type('#recipient', B);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B hook');
    const signsBeforeHook = h.controls.signs;
    click('#send');
    check('hook token: refused before signing', text('#send-result').includes('not support') && h.controls.signs === signsBeforeHook, text('#send-result'));

    pick('#asset', feeMint);
    check('fee token: warned', text('#token-note').includes('1% fee'), text('#token-note'));
    type('#amount', '10'); type('#recipient', B);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B fee token');
    click('#send');
    await until(() => $('#send-result .ok, #send-result .error'), 'fee token sent');
    check('fee token sent', !!$('#send-result .ok'), text('#send-result'));
    const messages = h.controls.messages;
    h.select(1); // a new account in Phantom: approved with Phantom's popup, the app follows it
    await until(() => text('.top').includes(B.slice(0, 4)), 'B followed');
    check('switching in Phantom follows the account, no message to sign', h.controls.messages === messages, String(h.controls.messages - messages));
    await until(() => text('.segments').includes('Receive 2'), 'B incoming');
    click('[data-tab="incoming"]');
    check('fee token shows what the escrow holds', text('.view').includes('9.9 '), text('.view'));
    // Phantom revokes the site behind the app's back (as in Phantom's settings): Claim re-approves, then signs
    localStorage.setItem('harness:trusted', '[]');
    for (const m of [mint, feeMint]) {
      const row = [...document.querySelectorAll<HTMLElement>('#app .item')].find((el) => el.querySelector(`.mint[title="${m}"]`));
      row!.querySelector<HTMLButtonElement>('[data-claim]')!.click();
      await until(() => $('#list-result .ok, #list-result .error'), `claim ${m.slice(0, 4)}`);
      check(`claim ${m === mint ? 'SPL token' : 'fee token'}`, !!$('#list-result .ok'), text('#list-result'));
      await wait(300);
    }
    check('token claimed', (await h.tokenBalance(1, mint)) === 7.25);
    check('fee token claimed: 10 - 1% - 1%', (await h.tokenBalance(1, feeMint)) === 9.801, String(await h.tokenBalance(1, feeMint)));

    // Switch back via the list, then disconnect: no reconnect without a signature
    click('[data-menu]'); click(`.menu [data-use="${A}"]`); await wait(100);
    check('switch asks to select in Phantom', text('.switch-hint').includes('Select'), text('.switch-hint'));
    h.select(0);
    await until(() => text('.top').includes(A.slice(0, 4)), 'A active');
    h.select(1); await until(() => text('.top').includes(B.slice(0, 4)), 'back to B');
    check('switching back in Phantom', true);

    // B sends SOL back to A
    click('[data-tab="send"]'); type('#amount', '0.1'); type('#recipient', A);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check A');
    click('#send');
    await until(() => $('#send-result .ok, #send-result .error'), 'send back');
    check('send back from the second wallet', !!$('#send-result .ok'), text('#send-result'));

    // Real Phantom (side panel) may not announce a switch to an account that never connected: the add banner's
    // Connect button connects the account selected in Phantom
    const cIndex = await h.addEmptyAccount();
    const C = h.address(cIndex);
    h.controls.silentUntrusted = true;
    click('[data-menu]'); click('[data-add]'); await wait(100);
    click('.switch-hint [data-connect]'); // B still selected in Phantom
    await until(() => text('.switch-hint').includes('still has'), 'still selected hint');
    check('add: says when Phantom still has the active wallet selected', text('.switch-hint').includes(B.slice(0, 4)), text('.switch-hint'));
    h.select(cIndex); await wait(300);
    check('add: no event from Phantom, still on B', text('.top').includes(B.slice(0, 4)), text('.top'));
    click('.switch-hint [data-connect]');
    await until(() => text('.top').includes(C.slice(0, 4)), 'C connected with the button');
    check('add: Connect connects the account selected in Phantom', true);
    h.controls.silentUntrusted = false;
    // No event at all when switching to another connected wallet (Phantom side panel): the app notices by itself,
    // within about a second, without a click or focus
    h.controls.silentAll = true;
    const switchedAt = Date.now();
    h.select(1);
    await until(() => text('.top').includes(B.slice(0, 4)), 'B followed without an event', 3_000);
    check('switch noticed without an event or a click', Date.now() - switchedAt < 1_000, `${Date.now() - switchedAt} ms`);
    h.select(cIndex);
    await until(() => text('.top').includes(C.slice(0, 4)), 'C followed without an event', 3_000);
    h.select(1);
    await until(() => text('.top').includes(B.slice(0, 4)), 'B again', 3_000);
    h.controls.silentAll = false;
    // Remove C again (the checks below expect A and B only)
    h.select(cIndex); await until(() => text('.top').includes(C.slice(0, 4)), 'C active');
    click('[data-menu]'); click('[data-disconnect]'); await wait(200);
    h.select(1); await until(() => text('.top').includes(B.slice(0, 4)), 'back to B again');

    // Disconnect B only: A stays connected, B needs a new signature
    click('[data-menu]'); click('[data-disconnect]'); await wait(200);
    check('disconnect removes only that wallet', text('.wallet-list').includes(A.slice(0, 4)) && !text('.wallet-list').includes(B.slice(0, 4)), text('.wallet-list'));
    h.select(0);
    await until(() => text('.top').includes(A.slice(0, 4)), 'A still connected');
    check('other wallet still connected', true);
    h.select(1); await wait(300);
    check('disconnected wallet not followed', !$('.wallet') && text('.switch-hint').includes('You disconnected'), text().slice(0, 250));
    const signed = h.controls.messages;
    click('.switch-hint [data-connect]');
    await until(() => text('.top').includes(B.slice(0, 4)), 'B reconnected');
    check('reconnecting asks a signature', h.controls.messages === signed + 1, String(h.controls.messages - signed));

    // Disconnect both: nothing reconnects until Connect Phantom
    click('[data-menu]'); click('[data-disconnect]'); await wait(200);
    h.select(0); await until(() => text('.top').includes(A.slice(0, 4)), 'A active');
    click('[data-menu]'); click('[data-disconnect]'); await wait(200);
    h.select(1); await wait(300); h.select(0); await wait(300);
    check('last wallet disconnected: fully disconnected', !$('.wallet') && text().includes('Connect Phantom') && !$('.wallet-list'), text().slice(0, 200));
  } catch (err) {
    check('suite crashed', false, String((err as Error).message));
  }
  return { passed: results.filter((r) => r[1]).length, failed: results.filter((r) => !r[1]), total: results.length };
};
