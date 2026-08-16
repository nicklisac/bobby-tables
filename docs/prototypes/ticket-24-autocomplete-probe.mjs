/**
 * TICKET 24 VERIFICATION PROBE: Schema-Aware SQL Autocomplete & Bang-Mode Visuals
 *
 * Tests:
 * 1. Schema indexing from live SQLite catalog (tables, views, system tables, columns, types, PKs).
 * 2. SQL keyword, function, and table/column candidate generation with score ranking.
 * 3. Dot-qualifier scoping (e.g. `sample_data.col`).
 * 4. Context awareness (boosting tables after FROM/JOIN, columns after SELECT/WHERE).
 * 5. Bang-mode detection (! vs !!) and dynamic visual morphing.
 * 6. Interactive controller keyboard navigation (ArrowDown, ArrowUp, Tab/Enter selection, Escape).
 * 7. Schema reactivity upon creating and dropping dynamic tables.
 */

import {
  globalSchemaIndex, SchemaCompletionIndex,
  detectBangMode, analyzeSqlContext, getCompletionCandidates,
  SqlAutocompleteController, SQL_KEYWORDS, SQL_FUNCTIONS
} from '../../src/sql-autocomplete.js';

export async function runT24Probe(agent = window.__agent) {
  const results = {
    steps: [],
    passed: 0,
    failed: 0,
    ok: false,
    error: null,
  };

  function log(name, passed, detail = {}) {
    results.steps.push({ name, passed, detail });
    if (passed) {
      results.passed++;
      console.log(`✓ [T24 Probe] ${name}`, detail);
    } else {
      results.failed++;
      console.error(`✗ [T24 Probe] ${name}`, detail);
    }
  }

  try {
    if (!agent || !agent.sqlite3 || !agent.db) {
      throw new Error('Agent or SQLite DB handle missing on window.__agent');
    }
    const { sqlite3, db } = agent;

    // ────────────────────────────────────────────────────────────────
    // Step 1: Dictionaries & Schema Indexer
    // ────────────────────────────────────────────────────────────────
    const kwCount = SQL_KEYWORDS.length;
    const fnCount = SQL_FUNCTIONS.length;
    log('Step 1: SQL dictionaries loaded', kwCount >= 40 && fnCount >= 30, { kwCount, fnCount });

    const index = new SchemaCompletionIndex();
    await index.refreshFromDb(sqlite3, db);

    const hasSampleData = index.tables.some(t => t.name === 'sample_data');
    const sampleCols = index.columnsByTable['sample_data'] || [];
    const hasSampleCatCol = sampleCols.some(c => c.name === 'category' || c.name === 'name' || c.name === 'value');

    log('Step 1b: Live database schema indexed', hasSampleData && hasSampleCatCol, {
      totalTables: index.tables.length,
      sampleColsCount: sampleCols.length,
      sampleCols: sampleCols.map(c => c.name),
    });

    // ────────────────────────────────────────────────────────────────
    // Step 2: Bang-Mode Syntax Detection
    // ────────────────────────────────────────────────────────────────
    const bangNormal = detectBangMode('What is the highest selling product?');
    const bangShared = detectBangMode('!SELECT * FROM sample_data');
    const bangPrivate = detectBangMode('!!DELETE FROM sample_data WHERE id = 1');
    const bangLeadingSpaces = detectBangMode('   !SELECT 1');

    const bangOk = !bangNormal.isBang &&
      bangShared.isBang && !bangShared.isPrivate && bangShared.bangPrefix === '!' && bangShared.sqlText === 'SELECT * FROM sample_data' &&
      bangPrivate.isBang && bangPrivate.isPrivate && bangPrivate.bangPrefix === '!!' && bangPrivate.sqlText === 'DELETE FROM sample_data WHERE id = 1' &&
      bangLeadingSpaces.isBang && bangLeadingSpaces.bangPrefix === '!';

    log('Step 2: Bang-mode detection (! / !! / natural prompt)', bangOk, {
      normal: bangNormal,
      shared: bangShared,
      private: bangPrivate,
    });

    // ────────────────────────────────────────────────────────────────
    // Step 3: SQL Context & Token Analysis
    // ────────────────────────────────────────────────────────────────
    const ctx1 = analyzeSqlContext('!SELECT ', 8);
    const ctx2 = analyzeSqlContext('!SELECT * FROM sam', 18);
    const ctx3 = analyzeSqlContext('!SELECT sample_data.ca', 22);

    const ctxOk = ctx1.isAfterSelectOrWhere &&
      ctx2.isAfterFromOrJoin && ctx2.token === 'sam' &&
      ctx3.qualifier === 'sample_data' && ctx3.subToken === 'ca';

    log('Step 3: Caret context analysis & qualifiers', ctxOk, { ctx1, ctx2, ctx3 });

    // ────────────────────────────────────────────────────────────────
    // Step 4: Completion Candidate Generation & Hierarchy Ranking
    // ────────────────────────────────────────────────────────────────
    const candTable = getCompletionCandidates(ctx2, index);
    const topTable = candTable[0];
    const candDot = getCompletionCandidates(ctx3, index);
    const hasCategoryCol = candDot.some(c => c.label === 'category');

    // Hierarchy test: tables > views > system tables > keywords
    const testHierarchyCtx = analyzeSqlContext('!s', 2);
    const hierCandidates = getCompletionCandidates(testHierarchyCtx, index);

    const tblItem = hierCandidates.find(c => c.badge === 'TBL');
    const viewItem = hierCandidates.find(c => c.badge === 'VIEW');
    const sysItem = hierCandidates.find(c => c.badge === 'SYS');
    const kwItem = hierCandidates.find(c => c.badge === 'KW');

    const scoreOrderOk = (!tblItem || !sysItem || tblItem.score > sysItem.score) &&
      (!sysItem || !kwItem || sysItem.score > kwItem.score);

    const rankingOk = topTable && topTable.label === 'sample_data' && topTable.badge === 'TBL' &&
      hasCategoryCol && scoreOrderOk;

    log('Step 4: Candidate generation & hierarchy ranking (tables > views > sys > kw)', rankingOk, {
      topTable,
      scoreOrderOk,
      tblScore: tblItem ? `${tblItem.label}:${tblItem.score}` : 'none',
      sysScore: sysItem ? `${sysItem.label}:${sysItem.score}` : 'none',
      kwScore: kwItem ? `${kwItem.label}:${kwItem.score}` : 'none',
      dotCandidates: candDot.map(c => `${c.badge}:${c.label}`),
    });

    // ────────────────────────────────────────────────────────────────
    // Step 5: Bang-Mode Dynamic Visual Morphing
    // ────────────────────────────────────────────────────────────────
    const inputEl = document.getElementById('user-input');
    const badgeEl = document.getElementById('bang-badge');

    if (window.__agent.updateBangModeVisuals && inputEl && badgeEl) {
      // Test Shared Bang
      window.__agent.updateBangModeVisuals({ isBang: true, isPrivate: false, bangPrefix: '!' });
      const sharedVisualOk = !badgeEl.classList.contains('hidden') &&
        !badgeEl.classList.contains('bang-private') &&
        inputEl.classList.contains('bang-mode') &&
        inputEl.classList.contains('has-bang-badge');

      // Test Private Bang
      window.__agent.updateBangModeVisuals({ isBang: true, isPrivate: true, bangPrefix: '!!' });
      const privateVisualOk = !badgeEl.classList.contains('hidden') &&
        badgeEl.classList.contains('bang-private') &&
        inputEl.classList.contains('bang-private');

      // Test Reset
      window.__agent.updateBangModeVisuals({ isBang: false });
      const resetVisualOk = badgeEl.classList.contains('hidden') &&
        !inputEl.classList.contains('bang-mode') &&
        !inputEl.classList.contains('has-bang-badge');

      log('Step 5: Visual morphing DOM classes & badges', sharedVisualOk && privateVisualOk && resetVisualOk, {
        sharedVisualOk,
        privateVisualOk,
        resetVisualOk,
      });
    } else {
      log('Step 5: Visual morphing DOM test', false, { error: 'DOM elements missing' });
    }

    // ────────────────────────────────────────────────────────────────
    // Step 6: Interactive Controller & Keyboard Navigation
    // ────────────────────────────────────────────────────────────────
    const testInput = document.createElement('input');
    document.body.appendChild(testInput);

    const controller = new SqlAutocompleteController(testInput, {
      schemaIndex: index,
      alwaysSuggest: true,
    });

    testInput.value = '!SELECT ';
    testInput.setSelectionRange(8, 8);
    controller.handleInput();

    const openedOk = controller.isOpen && controller.candidates.length > 0;
    const initialIndex = controller.selectedIndex;
    const initialCount = controller.candidates.length;

    // Simulate ArrowDown
    controller.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const downIndex = controller.selectedIndex;

    // Simulate Tab / Enter insertion
    const selectedCandidate = controller.candidates[downIndex];
    controller.applyCandidate(selectedCandidate);
    const appliedValue = testInput.value;

    // Simulate Escape to test closing
    controller.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closedOnEscape = !controller.isOpen;

    controller.destroy();
    testInput.remove();

    const keyboardOk = openedOk && downIndex === ((initialIndex + 1) % initialCount) &&
      appliedValue.includes(selectedCandidate.insertText) && closedOnEscape;

    log('Step 6: Controller keyboard navigation & completion application', keyboardOk, {
      openedOk,
      initialIndex,
      downIndex,
      appliedValue,
      closedOnEscape,
    });

    // ────────────────────────────────────────────────────────────────
    // Step 7: Schema Reactivity (Dynamic DDL Refresh)
    // ────────────────────────────────────────────────────────────────
    const tempTableName = `probe_t24_table_${Date.now().toString(36)}`;
    await sqlite3.exec(db, `CREATE TABLE "${tempTableName}" (sku_code TEXT PRIMARY KEY, inventory_qty INTEGER, unit_cost REAL)`);

    await index.refreshFromDb(sqlite3, db);
    const hasNewTable = index.tables.some(t => t.name === tempTableName);
    const newCols = index.columnsByTable[tempTableName.toLowerCase()] || [];
    const hasNewCols = newCols.some(c => c.name === 'sku_code') && newCols.some(c => c.name === 'inventory_qty');

    // Clean up
    await sqlite3.exec(db, `DROP TABLE "${tempTableName}"`);
    await index.refreshFromDb(sqlite3, db);
    const tableCleaned = !index.tables.some(t => t.name === tempTableName);

    log('Step 7: Schema reactivity on dynamic DDL CREATE/DROP', hasNewTable && hasNewCols && tableCleaned, {
      hasNewTable,
      newCols: newCols.map(c => c.name),
      tableCleaned,
    });

    // Global Schema Index Sync
    await globalSchemaIndex.refreshFromDb(sqlite3, db);

    results.ok = results.failed === 0;
    return results;
  } catch (err) {
    console.error('[T24 Probe] Exception:', err);
    results.error = err.message;
    results.ok = false;
    return results;
  }
}
