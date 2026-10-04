// End-to-end UI suite, run in the harness page against a local validator:
//   await harness.setup(2); location.reload();   then   await runSuite()
// Each step drives the real UI (clicks, typing) and checks the screen and the chain. Returns pass/fail per check.
const h = (window as any).harness;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (s: string) => document.querySelector<HTMLElement>(`#app ${s}`);
const text = (s = '') => ((s ? $(s) : document.getElementById('app'))?.innerText ?? '').replace(/\s+/g, ' ');
const tab = () => $('.seg.active')?.dataset.tab;
const rpcRequests = () => performance.getEntriesByType('resource').filter((e) => e.name.includes(':8899')).length;
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

    // Send SOL (double click sends once)
    const signs = h.controls.signs;
    click('#send'); click('#send');
    await until(() => $('#send-result .ok'), 'sent');
    check('send once on double click', h.controls.signs === signs + 1, String(h.controls.signs - signs));
    check('form cleared after send', ($('#amount') as HTMLInputElement).value === '' && ($('#recipient') as HTMLInputElement).value === '');
    await until(() => text('.segments').includes('Pending 1'), 'pending count');

    // Cancel and refund
    click('[data-tab="sent"]');
    const before = await h.balance(0);
    click('[data-cancel]');
    await until(() => $('#list-result .ok'), 'cancel');
    const refund = (await h.balance(0)) - before;
    check('cancel refunds amount + rent', refund > 0.5e9, String(refund));
    await wait(1500);
    check('cancelled transfer stays gone', !text('.segments').includes('Pending 1'), text('.segments'));

    // Tokens: send to B, add B, switch, claim
    const mint = await h.mintTokens(0, 100);
    await wait(21_000); // tabs reload from the network at most every 20 s
    click('[data-tab="incoming"]'); click('[data-tab="send"]');
    await until(() => [...($('#asset') as HTMLSelectElement).options].some((o) => o.value === mint), 'token listed');
    pick('#asset', mint);
    check('token balance', text('#balance').includes('100'), text('#balance'));
    type('#amount', '7.25'); type('#recipient', B);
    await until(() => !($('#send') as HTMLButtonElement).disabled, 'check B token');
    click('#send');
    await until(() => $('#send-result .ok'), 'token sent');
    const messages = h.controls.messages;
    h.select(1); // a new account in Phantom: approved with Phantom's popup, the app follows it
    await until(() => text('.top').includes(B.slice(0, 4)), 'B followed');
    check('switching in Phantom follows the account, no message to sign', h.controls.messages === messages, String(h.controls.messages - messages));
    await until(() => text('.segments').includes('Receive 1'), 'B incoming');
    click('[data-tab="incoming"]'); click('[data-claim]');
    await until(() => $('#list-result .ok'), 'token claim');
    check('token claimed', (await h.tokenBalance(1, mint)) === 7.25);

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

    // Disconnect: switching accounts in Phantom no longer reconnects
    click('[data-menu]'); click('[data-disconnect]'); await wait(200);
    h.select(0); await wait(300); h.select(1); await wait(300);
    check('disconnected: stays disconnected', !$('.wallet') && text().includes('Connect Phantom'), text().slice(0, 200));
  } catch (err) {
    check('suite crashed', false, String((err as Error).message));
  }
  return { passed: results.filter((r) => r[1]).length, failed: results.filter((r) => !r[1]), total: results.length };
};
