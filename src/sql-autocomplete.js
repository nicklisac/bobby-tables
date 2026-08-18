/**
 * SQL AUTOCOMPLETE & EDITOR ENGINE — Ticket 24
 *
 * Provides schema-aware autocomplete, SQL keyword/function completion dictionaries,
 * floating popover UI with full keyboard navigation (Arrow keys, Tab, Enter, Esc),
 * and bang-mode (! / !!) syntax detection & helper hooks.
 */

import { getDatabaseCatalog } from './explorer.js';

// ── SQL Keyword & Function Dictionaries ──────────────────────────────

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'DROP TABLE', 'ALTER TABLE',
  'CREATE VIEW', 'DROP VIEW', 'CREATE INDEX', 'DROP INDEX', 'WITH', 'AS',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
  'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ALL',
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'NOT NULL', 'DEFAULT', 'CHECK', 'UNIQUE', 'AUTOINCREMENT',
  'EXPLAIN', 'PRAGMA', 'ASC', 'DESC', 'ON', 'COLLATE', 'CAST'
];

export const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL',
  'COALESCE', 'NULLIF', 'IFNULL', 'ROUND', 'ABS',
  'LENGTH', 'LOWER', 'UPPER', 'SUBSTR', 'INSTR', 'TRIM', 'LTRIM', 'RTRIM', 'REPLACE',
  'TYPEOF', 'HEX', 'QUOTE', 'RANDOM', 'RANDOMBLOB', 'ZEROBLOB',
  'DATE', 'TIME', 'DATETIME', 'JULIANDAY', 'STRFTIME',
  'JSON_EXTRACT', 'JSON_EACH', 'JSON_TREE', 'JSON_ARRAY', 'JSON_OBJECT',
  'JSON_TYPE', 'JSON_VALID', 'JSON_QUOTE', 'JSON_GROUP_ARRAY', 'JSON_GROUP_OBJECT',
  'SEARCH_WEB', 'FETCH_URL', 'MATERIALIZE'
];

export const SQL_TYPES = [
  'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME', 'VARCHAR'
];

// ── Schema Indexer ───────────────────────────────────────────────────

export class SchemaCompletionIndex {
  constructor() {
    this.tables = [];          // [{ name, type: 'table'|'view'|'system', rowCount }]
    this.columns = [];         // [{ name, tableName, type, pk, isView }]
    this.columnsByTable = {};  // { [tableName]: [{ name, type, pk }] }
    this.tableNamesSet = new Set();
    this.columnNamesSet = new Set();
    this.lastUpdated = null;
    // BUG-008: the index is refreshed LAZILY. data_change marks it stale (no DB
    // read); the actual re-read runs only when the user next enters bang (SQL)
    // mode. This keeps the schema re-read from being a concurrent SQL flow that
    // races a turn's cascade and deadlocks the single-connection VFS.
    this.stale = true;
    this.refreshing = false;
  }

  /**
   * Update index from a getDatabaseCatalog() result object.
   */
  updateFromCatalog(catalog) {
    if (!catalog) return;

    this.tables = [];
    this.columns = [];
    this.columnsByTable = {};
    this.tableNamesSet.clear();
    this.columnNamesSet.clear();

    const allSources = [
      ...(catalog.userTables || []).map(t => ({ ...t, kind: 'table' })),
      ...(catalog.views || []).map(v => ({ ...v, kind: 'view' })),
      ...(catalog.systemTables || []).map(s => ({ ...s, kind: 'system' })),
    ];

    for (const item of allSources) {
      const tblName = item.name;
      this.tables.push({
        name: tblName,
        type: item.kind,
        rowCount: item.rowCount ?? null,
      });
      this.tableNamesSet.add(tblName.toLowerCase());

      const cols = item.columns || [];
      this.columnsByTable[tblName.toLowerCase()] = cols.map(c => ({
        name: c.name,
        type: c.type || 'TEXT',
        pk: !!c.pk,
      }));

      for (const col of cols) {
        this.columns.push({
          name: col.name,
          tableName: tblName,
          type: col.type || 'TEXT',
          pk: !!col.pk,
          isView: item.kind === 'view',
          isSystem: item.kind === 'system',
        });
        this.columnNamesSet.add(col.name.toLowerCase());
      }
    }

    this.lastUpdated = Date.now();
    this.stale = false;
  }

  /**
   * Refresh schema index directly from live SQLite database.
   */
  async refreshFromDb(sqlite3, db) {
    if (!sqlite3 || !db) return;
    if (this.refreshing) return; // coalesce concurrent refresh requests
    this.refreshing = true;
    try {
      const catalog = await getDatabaseCatalog(sqlite3, db);
      this.updateFromCatalog(catalog);
    } catch (err) {
      console.warn('[sql-autocomplete] Schema refresh failed:', err);
    } finally {
      this.refreshing = false;
    }
  }
}

// Global shared index instance
export const globalSchemaIndex = new SchemaCompletionIndex();

// ── Bang-Mode Syntax Detector ────────────────────────────────────────

/**
 * Detect if input text is a Direct SQL (! / !!) command.
 * Returns metadata about the bang mode.
 */
export function detectBangMode(text) {
  if (typeof text !== 'string') return { isBang: false, isPrivate: false, bangPrefix: '', sqlText: '' };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('!!')) {
    return {
      isBang: true,
      isPrivate: true,
      bangPrefix: '!!',
      sqlText: trimmed.slice(2).trimStart(),
      rawOffset: text.indexOf('!!') + 2,
    };
  }
  if (trimmed.startsWith('!')) {
    return {
      isBang: true,
      isPrivate: false,
      bangPrefix: '!',
      sqlText: trimmed.slice(1).trimStart(),
      rawOffset: text.indexOf('!') + 1,
    };
  }
  return { isBang: false, isPrivate: false, bangPrefix: '', sqlText: text, rawOffset: 0 };
}

// ── Token & Context Analysis ─────────────────────────────────────────

/**
 * Extract active token and query context at caret position.
 */
export function analyzeSqlContext(fullText, caretPos) {
  const textBeforeCaret = fullText.slice(0, caretPos);
  
  // Strip leading bang if present for SQL context analysis
  const bangInfo = detectBangMode(fullText);
  let effectiveTextBefore = textBeforeCaret;
  if (bangInfo.isBang && textBeforeCaret.startsWith(bangInfo.bangPrefix)) {
    effectiveTextBefore = textBeforeCaret.slice(bangInfo.bangPrefix.length).trimStart();
  }

  // Find the token under caret (word characters, underscores, and dots)
  const match = effectiveTextBefore.match(/([a-zA-Z0-9_.]*)$/);
  const token = match ? match[1] : '';
  const tokenStart = caretPos - token.length;

  // Check if token has a table qualifier (e.g. `users.na`)
  let qualifier = null;
  let subToken = token;
  if (token.includes('.')) {
    const parts = token.split('.');
    qualifier = parts[0];
    subToken = parts.slice(1).join('.');
  }

  // Simple context heuristics:
  // Detect if previous keyword was FROM, JOIN, INTO, TABLE, UPDATE
  const upperBefore = effectiveTextBefore.toUpperCase();
  const isAfterFromOrJoin = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+[a-zA-Z0-9_.,\s]*$/i.test(effectiveTextBefore);
  const isAfterSelectOrWhere = /\b(SELECT|WHERE|AND|OR|ON|HAVING|ORDER BY|GROUP BY|SET)\s+[a-zA-Z0-9_.,\s]*$/i.test(effectiveTextBefore);

  // Extract any referenced tables in the query (FROM/JOIN/INTO/UPDATE clauses + dot-prefixes like `sessions.name`)
  const referencedTables = new Set();
  
  // 1. From dot-notation qualifiers anywhere in the query (e.g. `sessions.id`, `sample_data.value`)
  const dotMatches = fullText.matchAll(/\b([a-zA-Z0-9_]+)\.[a-zA-Z0-9_*]+/gi);
  for (const dm of dotMatches) {
    if (dm[1]) referencedTables.add(dm[1].toLowerCase());
  }

  // 2. From FROM / JOIN / INTO / UPDATE / TABLE clauses
  const tableMatches = fullText.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["`]?([a-zA-Z0-9_]+)["`]?/gi);
  for (const m of tableMatches) {
    if (m[1]) referencedTables.add(m[1].toLowerCase());
  }

  return {
    token,
    subToken,
    qualifier,
    tokenStart,
    tokenEnd: caretPos,
    isAfterFromOrJoin,
    isAfterSelectOrWhere,
    referencedTables,
    isBang: bangInfo.isBang,
  };
}

// ── Completion Candidates Generator ──────────────────────────────────

/**
 * Generate sorted completion candidates for the given query context.
 */
export function getCompletionCandidates(context, schemaIndex = globalSchemaIndex) {
  const { token, subToken, qualifier, isAfterFromOrJoin, isAfterSelectOrWhere, referencedTables } = context;
  const search = (qualifier ? subToken : token).toLowerCase();

  // If user typed dot qualifier (e.g. `sample_data.`)
  if (qualifier) {
    const qLower = qualifier.toLowerCase();
    const tableCols = schemaIndex.columnsByTable[qLower] || [];
    return tableCols
      .filter(c => c.name.toLowerCase().startsWith(search))
      .map(c => ({
        label: c.name,
        type: 'column',
        badge: 'COL',
        detail: `${c.type}${c.pk ? ' (PK)' : ''}`,
        insertText: c.name,
        score: 100 - c.name.length,
      }));
  }

  const results = [];
  const seenLabels = new Set();

  // 1. Tables, Views & System Tables
  for (const t of schemaIndex.tables) {
    const nameLower = t.name.toLowerCase();
    const isReferenced = referencedTables.has(nameLower);

    if (!search || nameLower.startsWith(search) || (search.length >= 2 && nameLower.includes(search))) {
      const isPrefix = nameLower.startsWith(search);
      const isView = t.type === 'view';
      const isSys = t.type === 'system';

      // Ordering priority: User Tables (95/65) > Views (85/55) > System Tables (75/45)
      let score = isPrefix
        ? (isSys ? 75 : (isView ? 85 : 95))
        : (isSys ? 45 : (isView ? 55 : 65));

      if (isAfterFromOrJoin) score += 30; // Boost all sources after FROM / JOIN
      if (isReferenced) score += 100;     // Massive boost if table was already used/prefixed in the query!

      const badge = isView ? 'VIEW' : (isSys ? 'SYS' : 'TBL');
      results.push({
        label: t.name,
        type: isView ? 'view' : (isSys ? 'system' : 'table'),
        badge,
        detail: isReferenced
          ? `${t.rowCount !== null ? t.rowCount + ' rows · ' : ''}used in query`
          : (t.rowCount !== null ? `${t.rowCount} rows` : (isView ? 'view' : (isSys ? 'system table' : 'table'))),
        insertText: t.name,
        score,
      });
      seenLabels.add(`tbl:${t.name}`);
    }
  }

  // 2. Columns
  for (const c of schemaIndex.columns) {
    const nameLower = c.name.toLowerCase();
    const isRefTable = referencedTables.has(c.tableName.toLowerCase());

    if (!search || nameLower.startsWith(search) || (search.length >= 2 && nameLower.includes(search))) {
      let score = nameLower.startsWith(search) ? 65 : 35;
      if (isRefTable) score += 55; // Boost columns from tables mentioned in query (-> 120)
      if (isAfterSelectOrWhere && !isAfterFromOrJoin && isRefTable) score += 10;
      if (c.pk && isRefTable) score += 5;
      if (c.isSystem && !isRefTable) score -= 15;

      const key = `col:${c.tableName}.${c.name}`;
      if (!seenLabels.has(key)) {
        seenLabels.add(key);
        results.push({
          label: c.name,
          type: 'column',
          badge: 'COL',
          detail: `${c.tableName} · ${c.type}`,
          insertText: c.name,
          score,
        });
      }
    }
  }

  // 3. SQL Keywords (only if not searching after dot) — ranked below system tables
  if (!qualifier) {
    for (const kw of SQL_KEYWORDS) {
      const kwLower = kw.toLowerCase();
      if (!search || kwLower.startsWith(search)) {
        let score = kwLower.startsWith(search) ? 60 : 30;
        if (isAfterFromOrJoin && (kw === 'JOIN' || kw === 'WHERE' || kw === 'ORDER BY' || kw === 'LIMIT')) score += 10;

        results.push({
          label: kw,
          type: 'keyword',
          badge: 'KW',
          detail: 'SQL keyword',
          insertText: kw,
          score,
        });
      }
    }

    // 4. SQL Functions
    for (const fn of SQL_FUNCTIONS) {
      const fnLower = fn.toLowerCase();
      if (!search || fnLower.startsWith(search)) {
        const score = fnLower.startsWith(search) ? 50 : 25;
        results.push({
          label: `${fn}()`,
          type: 'function',
          badge: 'FN',
          detail: 'Function',
          insertText: `${fn}()`,
          cursorOffset: -1, // Place cursor inside parenthesis
          score,
        });
      }
    }
  }

  // Sort by score DESC, then alphabetical
  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  // Return top candidates
  return results.slice(0, 40);
}

// ── Floating Autocomplete UI Component ───────────────────────────────

export class SqlAutocompleteController {
  constructor(inputEl, options = {}) {
    this.inputEl = inputEl;
    this.options = {
      schemaIndex: globalSchemaIndex,
      onBangModeChange: null, // fn({ isBang, isPrivate, bangPrefix })
      requireBang: true,      // ONLY autocomplete when text starts with ! or !! (unless alwaysSuggest: true)
      alwaysSuggest: false,   // For Card SQL editor or dedicated SQL boxes
      maxItems: 25,
      ...options,
    };

    this.dropdownEl = null;
    this.candidates = [];
    this.selectedIndex = -1;
    this.isOpen = false;
    this.lastContext = null;

    this.initDropdown();
    this.bindEvents();
  }

  initDropdown() {
    this.dropdownEl = document.createElement('div');
    this.dropdownEl.className = 'sql-autocomplete-dropdown hidden';
    this.dropdownEl.setAttribute('role', 'listbox');
    this.dropdownEl.setAttribute('aria-label', 'SQL Suggestions');
    document.body.appendChild(this.dropdownEl);
  }

  bindEvents() {
    this._onInput = () => this.handleInput();
    this._onKeyDown = (e) => this.handleKeyDown(e);
    this._onFocus = () => {
      const bang = detectBangMode(this.inputEl.value || '');
      if (this.options.alwaysSuggest || (this.options.requireBang && bang.isBang)) {
        this.handleInput();
      }
    };
    this._onBlur = () => {
      // Delay closing to allow mousedown on dropdown items to fire first
      setTimeout(() => {
        if (document.activeElement !== this.inputEl) {
          this.close();
        }
      }, 150);
    };

    this.inputEl.addEventListener('input', this._onInput);
    this.inputEl.addEventListener('keydown', this._onKeyDown);
    this.inputEl.addEventListener('focus', this._onFocus);
    this.inputEl.addEventListener('blur', this._onBlur);

    // Prevent mousedown inside dropdown from stealing focus
    this.dropdownEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
  }

  handleInput() {
    const text = this.inputEl.value || '';
    const caretPos = this.inputEl.selectionStart || 0;

    // 1. Notify bang-mode status change
    const bang = detectBangMode(text);
    if (typeof this.options.onBangModeChange === 'function') {
      this.options.onBangModeChange(bang);
    }

    // 2. Strict Bang Enforcement: Autocomplete ONLY appears when text starts with ! or !!
    // (unless explicitly set to alwaysSuggest, such as the Card SQL editor)
    if (!this.options.alwaysSuggest && (!bang.isBang || !this.options.requireBang)) {
      this.close();
      return;
    }

    // Lazy refresh: only now, in bang mode, if the index is sparse or was marked
    // stale by a data_change. This is the ONLY place the schema re-read runs on
    // user input — never eagerly on data_change (see BUG-008).
    const idx = this.options.schemaIndex;
    if ((idx.tables.length <= 1 || idx.stale) && window.__agent?.sqlite3 && window.__agent?.db) {
      idx.refreshFromDb(window.__agent.sqlite3, window.__agent.db).catch(() => {});
    }

    // 3. Analyze context and fetch candidates
    const context = analyzeSqlContext(text, caretPos);
    this.lastContext = context;

    // If token length is 0 and not in bang mode or after dot, keep closed
    if (context.token.length === 0 && !context.qualifier && !bang.isBang && !this.options.alwaysSuggest) {
      this.close();
      return;
    }

    this.candidates = getCompletionCandidates(context, this.options.schemaIndex);
    if (this.candidates.length === 0) {
      this.close();
      return;
    }

    this.selectedIndex = 0;
    this.render();
    this.open();
  }

  handleKeyDown(e) {
    if (!this.isOpen) {
      // Allow Ctrl+Space or Alt+/ to manually trigger completions
      if ((e.ctrlKey && e.code === 'Space') || (e.altKey && e.code === 'Slash')) {
        e.preventDefault();
        this.handleInput();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.candidates.length;
      this.updateSelectionVisuals();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.candidates.length) % this.candidates.length;
      this.updateSelectionVisuals();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (this.selectedIndex >= 0 && this.selectedIndex < this.candidates.length) {
        e.preventDefault();
        e.stopPropagation();
        this.applyCandidate(this.candidates[this.selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  applyCandidate(candidate) {
    if (!candidate || !this.lastContext) return;

    const fullText = this.inputEl.value || '';
    const { tokenStart, tokenEnd, qualifier } = this.lastContext;

    // If there's a qualifier (e.g. `users.`), replace only after the dot
    let replaceStart = tokenStart;
    if (qualifier) {
      replaceStart = tokenStart + qualifier.length + 1;
    }

    const insert = candidate.insertText;
    const before = fullText.slice(0, replaceStart);
    const after = fullText.slice(tokenEnd);
    const newText = before + insert + after;

    this.inputEl.value = newText;
    
    // Set caret position
    let newCaret = replaceStart + insert.length;
    if (candidate.cursorOffset) {
      newCaret += candidate.cursorOffset;
    }
    this.inputEl.setSelectionRange(newCaret, newCaret);

    // Trigger input event to re-evaluate bang-mode and styling
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    this.close();
    this.inputEl.focus();
  }

  render() {
    this.dropdownEl.innerHTML = '';
    const items = this.candidates.slice(0, this.options.maxItems);

    items.forEach((c, idx) => {
      const itemEl = document.createElement('div');
      itemEl.className = `sql-autocomplete-item ${idx === this.selectedIndex ? 'selected' : ''}`;
      itemEl.dataset.index = String(idx);
      itemEl.setAttribute('role', 'option');
      itemEl.setAttribute('aria-selected', idx === this.selectedIndex ? 'true' : 'false');

      const badgeClass = `badge-${c.badge.toLowerCase()}`;
      itemEl.innerHTML = `
        <span class="sql-item-badge ${badgeClass}">${c.badge}</span>
        <span class="sql-item-label">${escapeHtml(c.label)}</span>
        <span class="sql-item-detail">${escapeHtml(c.detail || '')}</span>
      `;

      itemEl.addEventListener('click', (e) => {
        e.preventDefault();
        this.applyCandidate(c);
      });

      this.dropdownEl.appendChild(itemEl);
    });

    this.position();
  }

  position() {
    if (!this.inputEl || !this.dropdownEl) return;
    const rect = this.inputEl.getBoundingClientRect();
    
    // Check available space above vs below
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const dropdownHeight = Math.min(260, this.candidates.length * 32 + 10);

    if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
      // Place above input
      this.dropdownEl.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      this.dropdownEl.style.top = 'auto';
    } else {
      // Place below input
      this.dropdownEl.style.top = `${rect.bottom + 6}px`;
      this.dropdownEl.style.bottom = 'auto';
    }

    this.dropdownEl.style.left = `${Math.max(10, rect.left)}px`;
    this.dropdownEl.style.width = `${Math.min(rect.width, 420)}px`;
  }

  updateSelectionVisuals() {
    const items = this.dropdownEl.querySelectorAll('.sql-autocomplete-item');
    items.forEach((el, idx) => {
      const isSel = idx === this.selectedIndex;
      el.classList.toggle('selected', isSel);
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (isSel) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  open() {
    if (this.isOpen) {
      this.position();
      return;
    }
    this.isOpen = true;
    this.dropdownEl.classList.remove('hidden');
    this.position();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dropdownEl.classList.add('hidden');
    this.selectedIndex = -1;
  }

  destroy() {
    this.close();
    this.inputEl.removeEventListener('input', this._onInput);
    this.inputEl.removeEventListener('keydown', this._onKeyDown);
    this.inputEl.removeEventListener('focus', this._onFocus);
    this.inputEl.removeEventListener('blur', this._onBlur);
    if (this.dropdownEl && this.dropdownEl.parentNode) {
      this.dropdownEl.parentNode.removeChild(this.dropdownEl);
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
