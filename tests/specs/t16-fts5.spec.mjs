// Ticket 16 — In-browser full-text search (fts5).
//
// The probe (docs/prototypes/ticket-16-fts5-probe.mjs) verifies, against the
// live app DB:
//   A. boot schema — documents + documents_fts + 3 sync triggers + unique
//      index; both new tools registered; NO capture triggers on the corpus
//      (T21 boundary); boot invariant passes;
//   B. library round-trip — ingest → BM25 search (rank + snippet) → upsert
//      dedup → update + delete index sync → malformed-query throw;
//   C. a REAL trigger cascade driving ingest_document + search_documents
//      end-to-end (tools rows + execute_tool arms + UDF registration);
//   D. T21 boundary through the real agent path — execute_sql INSERT INTO
//      documents is refused and no row lands.
//
// This spec is the guard: if a future schema/harness change breaks the FTS5
// corpus, the sync triggers, the tool wiring, or the protected-tables
// boundary, this fails loudly.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T16 — in-browser full-text search (fts5)', () => {
  test('corpus schema, BM25 search, tool cascade, and T21 boundary', async ({ page }) => {
    // Two fake-LLM cascades + cleanup — slower than the sub-5s suite norm.
    test.setTimeout(60_000);
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const mod = await import(`/docs/prototypes/ticket-16-fts5-probe.mjs?t=${Date.now()}`);
      return mod.runT16Probe();
    });

    expect(result.fatal, result.fatal).toBeUndefined();
    expect(result.checks, JSON.stringify(result.facts, null, 2)).toEqual({
      okSchema: true,
      okLibrary: true,
      okCascade: true,
      okBoundary: true,
    });
    expect(result.verdict).toBe('GO');
    expect(result.cleaned).toBe(true);
  });
});
