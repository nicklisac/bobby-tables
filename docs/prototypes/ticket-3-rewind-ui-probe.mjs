// Ticket 3 rewind UI probe — verifies the ⟲ button -> confirm -> rewind wiring.
// Runs in the live page against the real agent DB (mutates the default session:
// adds a captured DML row for the latest user turn, then rewinds it).
//
// Run in the browser (Vite dev server): import('/docs/prototypes/ticket-3-rewind-ui-probe.mjs')
//   .then(m => m.runRewindUiProbe())
// Returns { ok, confirmMsg, marker, rowGone, csBefore, csAfter, integrity, ... }.
export async function runRewindUiProbe() {
  const R = { steps: {} };
  try {
    const { sqlite3, db } = window.__agent;
    const q = async (sql, params = []) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };
    const exec = async (sql, params = []) => {
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        await sqlite3.step(stmt);
      }
    };

    // Use the most recent user message as the rewind target.
    const userMsg = (await q(`SELECT id FROM messages WHERE session_id='default' AND role='user' ORDER BY id DESC LIMIT 1`))[0];
    if (!userMsg) return { noUserMsg: true };
    const M = userMsg[0];
    R.M = M;

    // Step 1: simulate a captured DML on turn M.
    await exec(`UPDATE session_context SET value = ? WHERE key = 'current_turn_id'`, [String(M)]);
    R.tpBefore = (await q(`SELECT COUNT(*) FROM test_products`))[0][0];
    await exec(`INSERT INTO test_products (name, price, quantity) VALUES ('Rewind UI Test', 1.0, 1)`);
    // test_products.id is a plain INTEGER (not autoincrement), so identify the
    // probe row by its unique name, not by id.
    R.rowExists = (await q(`SELECT COUNT(*) FROM test_products WHERE name='Rewind UI Test'`))[0][0] === 1;
    R.csBefore = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE turn_id = ?`, [M]))[0][0];
    R.steps.s1 = { rowExists: R.rowExists, csBefore: R.csBefore };

    // Step 2: auto-accept confirm, click the rewind button for message M.
    const realConfirm = window.confirm;
    let confirmMsg = null;
    window.confirm = (msg) => { confirmMsg = msg; return true; };
    try {
      const btns = Array.from(document.querySelectorAll('.rewind-btn'));
      R.rewindBtnCount = btns.length;
      const btn = btns[btns.length - 1]; // most recent user message = M
      if (!btn) throw new Error('no rewind button');
      btn.click();
      // Wait for the async rewind.
      await new Promise(r => setTimeout(r, 2500));
    } finally {
      window.confirm = realConfirm;
    }
    R.confirmCalled = !!confirmMsg;
    R.confirmMsg = confirmMsg ? String(confirmMsg).slice(0, 140) : null;

    // Step 3: verify the rewind.
    R.tpAfter = (await q(`SELECT COUNT(*) FROM test_products`))[0][0];
    R.rowGone = (await q(`SELECT COUNT(*) FROM test_products WHERE name='Rewind UI Test'`))[0][0] === 0;
    R.csAfter = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE turn_id = ?`, [M]))[0][0];
    R.marker = (await q(`SELECT content FROM messages WHERE role='assistant' AND instr(content, 'rewound to before message') > 0 ORDER BY id DESC LIMIT 1`))[0]?.[0] || null;
    R.suppressCapture = (await q(`SELECT value FROM session_context WHERE key='suppress_capture'`))[0]?.[0];
    R.integrity = (await q(`PRAGMA integrity_check`))[0][0];

    R.ok = R.rowExists && R.csBefore >= 1 && R.confirmCalled && R.rowGone && R.csAfter === 0 && !!R.marker && R.tpAfter === R.tpBefore && R.suppressCapture === '0' && R.integrity === 'ok';
    return R;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
