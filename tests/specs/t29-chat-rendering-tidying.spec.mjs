// T29 — chat rendering & UI tidying: markdown, search-result polish,
// bracket-button collapse.
//
// Part 1 (markdown): chat text (assistant + user + tool text) renders as
// sanitized markdown (marked + DOMPurify) — bold/lists/fenced code/links render
// formatted, and untrusted HTML (<script>, onerror handlers) is stripped.
// Scratchpad user rows (!) stay monospace plain text.
//
// Part 2 (search polish): search_web results highlight the query terms
// (case-insensitive) in title + snippet; search_documents results turn FTS5's
// own [term] markers into highlights + a source badge; long snippets clamp to 3
// lines so they never break the pane.
//
// Part 3 (bracket buttons): the 6 top-bar buttons are icon-only at rest (the 4
// text buttons' labels are collapsed to zero width, so all 6 share one width);
// hovering a text button expands it to [icon text]; the 2 icon-only buttons
// (theme/architecture) have no label and stay put.
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig } from '../helpers.mjs';

const seedCfg = { provider: 'gemini', apiKey: 't29-fake-key', isConfigured: true, model: 'gemini-2.5-flash' };

/**
 * Seed message rows directly into the active (default) session — no LLM,
 * cascade suppressed — then re-render the pane once. `rows` = [id, role, content].
 */
async function seedMessages(page, rows) {
  await page.evaluate(async (rows) => {
    const { sqlite3, db } = window.__agent;
    for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
    try {
      for (const [id, role, content] of rows) {
        for await (const st of sqlite3.statements(db,
          `INSERT INTO messages (id, session_id, role, content) VALUES (?, 'default', ?, ?)`)) {
          sqlite3.bind_collection(st, [id, role, content]);
          await sqlite3.step(st);
        }
      }
    } finally {
      for await (const s of sqlite3.statements(db, `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`)) await sqlite3.step(s);
    }
    await window.__agent.renderMessages();
  }, rows);
}

const HEADER_BTN_IDS = [
  'btn-toggle-config', 'btn-export', 'btn-import', 'btn-upload-csv',
  'btn-theme-toggle', 'btn-architecture',
];

test.describe('T29 — chat rendering & UI tidying', () => {
  test('M1: markdown renders (bold/list/fenced-code/link) and untrusted HTML is sanitized', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    const md = [
      'Intro **bold** and a [link](http://example.com/path)',
      '',
      '- alpha',
      '- beta',
      '',
      '```js',
      'let x = 1;',
      '```',
      '',
      '<img src=x onerror="window.__t29pwn=1">',
      '<script>window.__t29pwn=1</script>',
    ].join('\n');
    await seedMessages(page, [[991001, 'assistant', md]]);

    const bubble = page.locator('#messages .message.assistant').filter({ has: page.locator('.md') }).first();
    await bubble.waitFor({ timeout: 15_000 });

    await expect(bubble.locator('.md strong')).toHaveText('bold');
    await expect(bubble.locator('.md a')).toHaveAttribute('href', 'http://example.com/path');
    await expect(bubble.locator('.md a')).toHaveAttribute('target', '_blank');
    await expect(bubble.locator('.md ul li')).toHaveCount(2);
    await expect(bubble.locator('.md pre code')).toContainText('let x = 1;');

    // Sanitized: no <script>, no event handlers, nothing executed.
    expect(await bubble.locator('.md script').count()).toBe(0);
    expect(await bubble.locator('.md [onerror]').count(), 'no onerror handler survives').toBe(0);
    expect(await page.evaluate(() => !!window.__t29pwn), 'no injected script ran').toBe(false);
  });

  test('M2: user messages render markdown; scratchpad (!) rows stay monospace plain text', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    await seedMessages(page, [
      [991010, 'user', 'Please show **the** data'],
      [991011, 'assistant', 'Sure, here it is.'],
      [991012, 'user', '!SELECT 1'],
    ]);

    const userMd = page.locator('#messages .message.user').filter({ has: page.locator('.md strong') }).first();
    await userMd.waitFor({ timeout: 15_000 });
    await expect(userMd.locator('.md strong')).toHaveText('the');

    const scratch = page.locator('#messages .message.user.scratchpad');
    expect(await scratch.count(), 'the ! row is a scratchpad bubble').toBe(1);
    expect(await scratch.locator('.md').count(), 'scratchpad is NOT markdown').toBe(0);
    expect((await scratch.first().textContent()).includes('!SELECT 1'), 'raw !SQL preserved').toBe(true);
  });

  test('S1: search_web results are polished + query terms highlighted; long snippets clamp', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    const web = JSON.stringify({ query: 'sqlite vector', results: [
      { title: 'SQLite Vector Guide', url: 'http://ex.com/v',
        snippet: 'About sqlite vector search, with extra words padded in here to make the snippet long enough to exercise the line clamping behavior of the result pane.' },
      { title: 'Unrelated Page', url: 'http://ex.com/u', snippet: 'No matching terms anywhere in this one.' },
    ] });
    await seedMessages(page, [[991020, 'tool', web]]);

    const list = page.locator('#messages .search-results-list').first();
    await list.waitFor({ timeout: 15_000 });
    const items = list.locator('.search-result-item');
    expect(await items.count()).toBe(2);

    const first = items.first();
    const hitTexts = (await first.locator('.search-hit').allTextContents()).join(' ').toLowerCase();
    expect(hitTexts, 'query term in title').toContain('sqlite');
    expect(hitTexts, 'query term in snippet').toContain('vector');
    expect(await first.locator('a.search-result-title').count(), 'web result title is a link').toBe(1);

    expect(await items.nth(1).locator('.search-hit').count(), 'unrelated item has no highlights').toBe(0);

    const clamp = await first.locator('.search-result-snippet')
      .evaluate((el) => getComputedStyle(el).webkitLineClamp);
    expect(clamp, 'long snippets clamp to 3 lines').toBe('3');
  });

  test('S2: search_documents FTS [term] markers become highlights + a source badge', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    const docs = JSON.stringify({ query: 'invoice total', count: 1, results: [
      { id: 7, source: 'user', sourceRef: 'd1', title: 'Invoice Summary',
        snippet: 'The [invoice] [total] was computed from the table.', rank: 1 },
    ] });
    await seedMessages(page, [[991030, 'tool', docs]]);

    const doc = page.locator('#messages .search-result-doc').first();
    await doc.waitFor({ timeout: 15_000 });
    const hits = (await doc.locator('.search-hit').allTextContents()).map((t) => t.toLowerCase());
    expect(hits, 'FTS [invoice] marker highlighted').toContain('invoice');
    expect(hits, 'FTS [total] marker highlighted').toContain('total');
    await expect(doc.locator('.search-result-source')).toHaveText('user');
  });

  test('S3: highlighting never splits an HTML entity (query term matching an entity fragment)', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    // "R&B" escapes to "R&amp;B"; a query of "amp" must NOT split the &amp;
    // entity (the pre-fix regex matched "amp" inside it and corrupted the text).
    const web = JSON.stringify({ query: 'amp', results: [
      { title: 'R&B Guide', url: 'http://ex.com/rb', snippet: 'All about R&B music and the amp setting.' },
    ] });
    await seedMessages(page, [[991040, 'tool', web]]);

    const item = page.locator('#messages .search-result-item').first();
    await item.waitFor({ timeout: 15_000 });
    const text = await item.textContent();
    expect(text, 'the & entity renders as a literal &').toContain('R&B');
    expect(text, 'no corrupted entity fragment leaks through').not.toContain('&amp;');
    const hits = await item.locator('.search-hit').allTextContents();
    expect(hits, 'the standalone "amp" is still highlighted').toContain('amp');
  });

  test('B1: top bar is 6 icon-only buttons at rest; a text button expands on hover; icon-only stay put', async ({ page }) => {
    test.setTimeout(45_000);
    await seedConfig(page, seedCfg);
    await bootPage(page);
    const bar = page.locator('#header-actions');
    expect(await bar.locator('.btn-header').count(), 'six top-bar buttons').toBe(6);

    // At rest: the 4 text buttons have zero-width labels, so all 6 share one width.
    const widths = {};
    for (const id of HEADER_BTN_IDS) {
      widths[id] = await bar.locator('#' + id).evaluate((el) => Math.round(el.getBoundingClientRect().width));
    }
    const vals = Object.values(widths);
    expect(Math.max(...vals) - Math.min(...vals), `at-rest widths uniform (${JSON.stringify(widths)})`).toBeLessThanOrEqual(2);
    for (const id of HEADER_BTN_IDS.slice(0, 4)) {
      const lw = await bar.locator('#' + id + ' .btn-label').evaluate((el) => getComputedStyle(el).maxWidth);
      expect(lw, `${id} label collapsed at rest`).toBe('0px');
    }
    // The 2 icon-only buttons carry no label.
    expect(await bar.locator('#btn-theme-toggle .btn-label').count()).toBe(0);
    expect(await bar.locator('#btn-architecture .btn-label').count()).toBe(0);

    // Hovering a text button expands it to [icon text].
    const cfg = bar.locator('#btn-toggle-config');
    const before = widths['btn-toggle-config'];
    await cfg.hover();
    await expect(cfg.locator('.btn-label')).toHaveCSS('opacity', '1');
    await page.waitForTimeout(250); // let the max-width transition settle
    const after = await cfg.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(after, `button widens on hover (${before} -> ${after})`).toBeGreaterThan(before + 10);

    // The other buttons keep their size (only the hovered one grows).
    const exportW = await bar.locator('#btn-export').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(exportW, 'sibling button size unchanged').toBe(widths['btn-export']);

    // The :focus-visible rule is present (keyboard focus expands too).
    const hasFocusRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const r of rules) {
          if ((r.selectorText || '').includes(':focus-visible .btn-label')) return true;
        }
      }
      return false;
    });
    expect(hasFocusRule, 'a :focus-visible .btn-label rule exists').toBe(true);
  });
});
