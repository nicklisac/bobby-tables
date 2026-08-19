// T28 — chat pane: live tool-call chips + blink-free re-render.
//
// Part B (live chips): during a turn, each tool call renders the real
// collapsible chip in a `running` state (spinner in the chip header) as soon
// as the LLM emits it — not a transient "Executing …" spinner whose chip only
// appears when the turn-end re-render lands. `tool_result` settles the
// matching chip; the T17 approval widget appears BELOW the running chip (the
// chip survives the approval_request). The turn-end re-render is a visual
// no-op: same chips, same open state, same scroll.
//
// Part A (blink-free swap): renderMessages() builds the whole pane into a
// DocumentFragment and swaps it in with ONE replaceChildren() — the pane is
// never observed empty (rAF-sampled), and the scroll position (pinned-to-
// bottom vs absolute offset) + expanded chip state survive the swap on every
// trigger (turn end, session switch, boot, rewind).
//
// Deterministic running-state windows come from route-intercepted slow
// fetch_url pages (page.route delays the fulfill); the parallel test reuses
// the BUG-019 fake-LLM shape with 3 staggered slow fetches.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig, createSessionViaUi } from '../helpers.mjs';

const FAKE_REPLY = 't28-ok-reply';
const SLOW_HOST = 'slow-t28.example';

/**
 * Route-intercepted slow pages: `?d=<ms>` delays the fulfill so the test has
 * a deterministic window in which the chip is `running` and no result has
 * landed. The path is the marker (`/p1` → body carries `marker-p1`) so each
 * parallel result is distinguishable.
 */
async function routeSlowPages(page) {
  await page.route(`**://${SLOW_HOST}/**`, async (route) => {
    const u = new URL(route.request().url());
    const d = parseInt(u.searchParams.get('d') || '800', 10);
    const marker = u.pathname.slice(1);
    await new Promise((r) => setTimeout(r, d));
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>${marker}</title></head><body>t28 marker-${marker}</body></html>`,
    });
  });
}

/** Fake LLM: call #1 issues the given tool_calls, call #2 replies. */
function routeToolTurn(page, toolCalls) {
  let calls = 0;
  page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? {
          choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const tc = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** rAF sampler: #messages must never be observed empty. */
async function startEmptySampler(page) {
  await page.evaluate(() => {
    window.__t28s = { min: Infinity, samples: 0, stop: false };
    const el = document.getElementById('messages');
    const tick = () => {
      if (window.__t28s.stop) return;
      window.__t28s.samples += 1;
      const n = el.childElementCount;
      if (n < window.__t28s.min) window.__t28s.min = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
async function stopEmptySampler(page) {
  return page.evaluate(() => {
    window.__t28s.stop = true;
    return window.__t28s;
  });
}

/**
 * Blink watcher: rAF-samples the computed opacity of #messages .message nodes
 * for 400ms, counting only nodes that did NOT exist when it armed (the
 * re-rendered ones — the live bubbles already in the pane are excluded, their
 * own fade-in is desired). Pre-T28 the re-rendered bubbles replayed the 150ms
 * fadeIn from opacity 0 (the perceived "whole UI blink") → min dips. Post-T28
 * the swapped-in nodes carry no-anim → min stays 1.
 * `armOnDone=true` arms on the 'done' event (turn-end re-render); false arms
 * immediately (session switch).
 */
async function startBlinkWatcher(page, armOnDone) {
  await page.evaluate((onDone) => {
    window.__t28blink = { min: 1, samples: 0, armed: false };
    const arm = () => {
      if (window.__t28blink.armed) return;
      window.__t28blink.armed = true;
      const preSwap = new Set(document.querySelectorAll('#messages .message'));
      const t0 = performance.now();
      const tick = () => {
        window.__t28blink.samples += 1;
        for (const el of document.querySelectorAll('#messages .message')) {
          if (preSwap.has(el)) continue;
          const o = parseFloat(getComputedStyle(el).opacity);
          if (o < window.__t28blink.min) window.__t28blink.min = o;
        }
        if (performance.now() - t0 < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (!onDone) { arm(); return; }
    const reader = window.__agent.eventStream.getStream().getReader();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'done') {
          arm();
          try { await reader.cancel(); } catch { /* closed */ }
          break;
        }
      }
    })();
  }, armOnDone);
}
const blinkResult = (page) => page.evaluate(() => window.__t28blink);

/** A second event-stream reader: records the event log for ordering asserts. */
async function startEventTap(page) {
  await page.evaluate(() => {
    window.__t28tap = { events: [] };
    const reader = window.__agent.eventStream.getStream().getReader();
    window.__t28tap.reader = reader;
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        window.__t28tap.events.push(value);
      }
    })();
  });
}
async function stopEventTap(page) {
  await page.evaluate(async () => {
    try { await window.__t28tap?.reader?.cancel(); } catch { /* already closed */ }
  });
}
const eventLog = (page) => page.evaluate(() => window.__t28tap.events);

/**
 * Seed a long conversation into `sessionId` (no LLM; cascade suppressed,
 * explicit ids from `startId`). Then re-render the active pane.
 */
async function seedLongSession(page, sessionId, marker, startId) {
  await page.evaluate(async ([sid, m, start]) => {
    const { sqlite3, db } = window.__agent;
    for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
    try {
      const line = `${m} row — `.padEnd(64, 'x');
      for (let i = 0; i < 40; i++) {
        for await (const st of sqlite3.statements(db,
          `INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)`)) {
          sqlite3.bind_collection(st, [start + i, sid, line.repeat(4)]);
          await sqlite3.step(st);
        }
      }
    } finally {
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
    }
    await window.__agent.renderMessages();
  }, [sessionId, marker, startId]);
}

const seedCfg = { provider: 'gemini', apiKey: 't28-fake-key', isConfigured: true, model: 'gemini-2.5-flash' };

test.describe('T28 — live tool-call chips + blink-free re-render', () => {
  test('A1: turn + turn-end re-render — pane never empty; pinned-to-bottom stays pinned', async ({ page }) => {
    test.setTimeout(60_000);
    // A slow fetch_url (not a fast execute_sql) so the rAF sampler gets a real
    // window of frames across the turn AND the turn-end re-render.
    await routeSlowPages(page);
    routeToolTurn(page, [tc('tc-1', 'fetch_url', { url: `http://${SLOW_HOST}/a1?d=800` })]);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    await startEmptySampler(page);
    await startBlinkWatcher(page, true);
    await page.fill('#user-input', 'run a query');
    await page.click('#send-btn');
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    // The send button re-enables AFTER the turn-end renderMessages() (main.js
    // finally-block order), so this guarantees the re-render has landed.
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    const s = await stopEmptySampler(page);

    expect(s.samples, 'the sampler actually ran').toBeGreaterThan(10);
    expect(s.min, '#messages was never observed empty through the swap').toBeGreaterThan(0);

    // The re-rendered bubbles never replay the fadeIn (the perceived blink).
    const b = await blinkResult(page);
    expect(b.samples, 'the blink watcher actually ran').toBeGreaterThan(5);
    expect(b.min, 'no opacity dip on the re-rendered bubbles').toBeGreaterThan(0.99);

    const scroll = await page.evaluate(() => {
      const c = document.getElementById('chat-container');
      return c.scrollHeight - c.scrollTop - c.clientHeight;
    });
    expect(scroll, 'pinned-to-bottom stays pinned after the re-render').toBeLessThanOrEqual(80);
  });

  test('A2+B3: chip runs before the result; expanded mid-turn it survives the re-render (set + open state)', async ({ page }) => {
    test.setTimeout(60_000);
    await routeSlowPages(page);
    routeToolTurn(page, [tc('tc-slow', 'fetch_url', { url: `http://${SLOW_HOST}/solo?d=1500` })]);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    await startEventTap(page);
    await page.fill('#user-input', 'fetch that page');
    await page.click('#send-btn');

    // The chip is live (running) BEFORE the tool_result lands.
    const running = page.locator('#messages .toolcall-chip.running');
    await running.waitFor({ timeout: 20_000 });
    expect(await running.count()).toBe(1);
    expect(await running.first().getAttribute('data-tc-id')).toBe('tc-slow');
    expect(await running.first().locator('.tool-spinner').count(), 'spinner in the chip header').toBe(1);
    expect(await page.locator('#messages .message.tool').count(), 'no result bubble yet').toBe(0);
    expect(await page.locator('#messages .tool-indicator').count(), 'no transient indicator').toBe(0);

    // Expand the RUNNING chip mid-turn.
    await running.first().locator('summary').click();
    expect(await running.first().evaluate((c) => c.open)).toBe(true);

    // The result lands → the chip settles.
    await page.locator('#messages .message.tool').first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('.toolcall-chip.running'), null, { timeout: 15_000 });

    // Turn end → re-render: the chip set + open state are unchanged (no pop-in).
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    expect(await page.locator('#messages .toolcall-chip').count(), 'chip set unchanged').toBe(1);
    const chip = page.locator('#messages .toolcall-chip[data-tc-id="tc-slow"]');
    expect(await chip.evaluate((c) => ({ open: c.open, running: c.classList.contains('running') })))
      .toEqual({ open: true, running: false });

    // Event log: the id-bearing tool_call precedes the tool_result.
    const log = await eventLog(page);
    const callIdx = log.findIndex((e) => e.type === 'tool_call' && e.id === 'tc-slow');
    const resultIdx = log.findIndex((e) => e.type === 'tool_result' && e.tool === 'fetch_url');
    expect(callIdx, 'id-bearing tool_call in the log').toBeGreaterThanOrEqual(0);
    expect(resultIdx, 'tool_result after the call').toBeGreaterThan(callIdx);
    await stopEventTap(page);
  });

  test('A3: session switch — pane never empty; a scrolled-up offset is preserved (not yanked to the bottom)', async ({ page }) => {
    test.setTimeout(60_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    // Long conversations in both sessions (seeded directly; no LLM).
    await seedLongSession(page, 'default', 'alpha', 9101);
    const betaId = await createSessionViaUi(page, 'beta');
    await seedLongSession(page, betaId, 'beta', 9201);

    // Scroll UP in the active (beta) pane — not pinned to the bottom.
    await page.evaluate(() => {
      const c = document.getElementById('chat-container');
      c.style.scrollBehavior = 'auto';
      c.scrollTop = 200;
    });
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => {
      const c = document.getElementById('chat-container');
      return { top: c.scrollTop, dist: c.scrollHeight - c.scrollTop - c.clientHeight };
    });
    expect(before.dist, 'precondition: scrolled up, not pinned').toBeGreaterThan(200);

    await startEmptySampler(page);
    await startBlinkWatcher(page, false);
    await page.click('#session-list .session-item:has-text("Default Session")');
    await page.locator('#messages .message.assistant').filter({ hasText: 'alpha' }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
    const s = await stopEmptySampler(page);

    expect(s.samples, 'the sampler actually ran').toBeGreaterThan(5);
    expect(s.min, '#messages was never observed empty across the switch').toBeGreaterThan(0);

    const b = await blinkResult(page);
    expect(b.samples, 'the blink watcher actually ran').toBeGreaterThan(5);
    expect(b.min, 'no opacity dip on the re-rendered bubbles').toBeGreaterThan(0.99);

    const after = await page.evaluate(() => {
      const c = document.getElementById('chat-container');
      return { top: c.scrollTop, dist: c.scrollHeight - c.scrollTop - c.clientHeight };
    });
    expect(Math.abs(after.top - before.top),
      `scrolled-up offset preserved (was ${before.top}, now ${after.top})`).toBeLessThanOrEqual(30);
  });

  test('B2: 3 parallel calls — 3 chips appear as the calls emit; each settles with its own result', async ({ page }) => {
    test.setTimeout(90_000);
    await routeSlowPages(page);
    routeToolTurn(page, [
      tc('p1', 'fetch_url', { url: `http://${SLOW_HOST}/p1?d=800` }),
      tc('p2', 'fetch_url', { url: `http://${SLOW_HOST}/p2?d=600` }),
      tc('p3', 'fetch_url', { url: `http://${SLOW_HOST}/p3?d=400` }),
    ]);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    await startEventTap(page);
    await page.fill('#user-input', 'fetch all three');
    await page.click('#send-btn');

    // All 3 chips are live (running) before the first result lands.
    await page.waitForFunction(
      () => document.querySelectorAll('.toolcall-chip.running').length === 3,
      null, { timeout: 20_000 });
    expect(await page.locator('#messages .message.tool').count(), 'no result bubble yet').toBe(0);
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('.toolcall-chip.running')].map((c) => c.dataset.tcId).sort());
    expect(ids).toEqual(['p1', 'p2', 'p3']);

    // Each result settles its chip; 3 distinct result bubbles land.
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 30_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    expect(await page.locator('#messages .toolcall-chip.running').count(), 'all chips settled').toBe(0);
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll('.toolcall-chip')].map((c) => c.dataset.tcId).sort());
    expect(chips).toEqual(['p1', 'p2', 'p3']);
    const bubbles = await page.locator('#messages .message.tool').allTextContents();
    expect(bubbles.length).toBe(3);
    for (const m of ['marker-p1', 'marker-p2', 'marker-p3']) {
      expect(bubbles.some((b) => b.includes(m)), `a result bubble carries ${m}`).toBe(true);
    }

    // Event log: the 3 id-bearing calls (the burst) precede the first tool_result.
    const log = await eventLog(page);
    const callIdxs = log.map((e, i) => (e.type === 'tool_call' && e.id ? i : -1)).filter((i) => i !== -1);
    expect(callIdxs, 'exactly 3 id-bearing tool_call events').toHaveLength(3);
    const firstResultIdx = log.findIndex((e) => e.type === 'tool_result');
    expect(Math.max(...callIdxs), 'the whole burst precedes the first result').toBeLessThan(firstResultIdx);
    await stopEventTap(page);
  });

  test('B4: write-SQL turn — the approval widget appears below the running chip; the chip settles after approval + result', async ({ page }) => {
    test.setTimeout(60_000);
    routeToolTurn(page, [tc('w1', 'execute_sql', {
      query: `DELETE FROM sample_data WHERE category = 'Electronics' AND value > 30`,
    })]);
    await seedConfig(page, seedCfg);
    await bootPage(page);

    await page.fill('#user-input', 'please run that write');
    await page.click('#send-btn');

    // The pending approval widget lands — the running chip is STILL there.
    const widget = page.locator('#messages .approval-widget').first();
    await widget.waitFor({ timeout: 20_000 });
    const chip = page.locator('#messages .toolcall-chip[data-tc-id="w1"]');
    expect(await chip.count(), 'the running chip survives the approval_request').toBe(1);
    expect(await chip.evaluate((c) => c.classList.contains('running'))).toBe(true);
    const order = await page.evaluate(() => {
      const chipMsg = document.querySelector('.toolcall-chip[data-tc-id="w1"]')?.closest('.message');
      const w = document.querySelector('.approval-widget');
      return chipMsg && w ? chipMsg.compareDocumentPosition(w) : null;
    });
    expect(order & 4 /* DOCUMENT_POSITION_FOLLOWING */, 'the widget sits below the chip').toBeTruthy();

    // Approve → the decision flips the widget; the result settles the chip.
    await page.locator('#messages button.approval-btn.approve').first().click();
    await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
    const state = await page.evaluate(() => ({
      chipRunning: document.querySelector('.toolcall-chip[data-tc-id="w1"]')?.classList.contains('running') ?? null,
      decided: document.querySelector('.approval-widget')?.dataset.decided || null,
      resultBubbles: document.querySelectorAll('#messages .message.tool').length,
    }));
    expect(state).toEqual({ chipRunning: false, decided: 'approved', resultBubbles: 1 });
  });
});
