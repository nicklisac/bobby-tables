// Ticket 2 cache probe — REAL LLM verification that the compaction design
// keeps the LLM prefix byte-stable between compactions: two consecutive turns
// (no compaction between them) must show a provider KV-cache hit on turn 2
// (usage.prompt_tokens_details.cached_tokens > 0 on the OpenAI-compat
// endpoint).
//
// Requires a working LLM config in the settings (the live one is used as-is).
// Mutates the ACTIVE session with two short chat turns.
//
// Run in the browser (Vite dev server :5174). Real LLM turns can exceed the
// 15s evaluate timeout, so the result is ALSO stored on
// window.__t2cacheResult for polling:
//   import('/docs/prototypes/ticket-2-cache-probe.mjs?cb=' + Date.now())
//     .then(m => m.runT2CacheProbe().then(r => { window.__t2cacheResult = r; }))
//   // …poll window.__t2cacheResult…
//
// Returns { ok, steps: {...} }.
export async function runT2CacheProbe() {
  window.__t2cacheResult = null;
  const R = { steps: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('user-input');
  const form = document.getElementById('input-form');

  // Capture the raw `usage` object(s) from every chat-completion response
  // (streaming final chunk or non-streaming body), WITHOUT blocking the
  // caller.
  //
  // CRITICAL (found empirically, 2026-08-14): the wrapper must be SYNCHRONOUS
  // and return the REAL fetch promise to the caller. An `async` wrapper — or
  // any wrapper that adds a microtask tick to the caller's await path — trips
  // a JSPI + IDBBatchAtomicVFS fiber-resumption race and hangs the turn at its
  // very first DB op (a `prepare` that suspends the fiber for an IDB schema
  // read and never resumes). So we return `p` (the real promise) directly and
  // inspect the response on a SEPARATE `.then` branch. For an SSE body we use
  // `resp.clone()` (an independent reader) so the harness's read of the
  // original body is unaffected — no tee, no new Response, no extra tick.
  const captured = [];
  const pendingInspections = new Set();
  const realFetch = window.fetch;
  const track = (p) => {
    pendingInspections.add(p);
    p.finally(() => pendingInspections.delete(p));
    return p;
  };
  const doProbe = (clone) => track((async () => {
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep a partial line
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') {
            try { await reader.cancel(); } catch { /* already done */ }
            return; // stop probing; don't wait for server EOF
          }
          try {
            const d = JSON.parse(payload);
            if (d.usage) captured.push({ kind: 'sse', usage: d.usage });
          } catch { /* not JSON */ }
        }
      }
    } catch { /* probe errors never affect the pass-through branch */ }
    finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  })());
  window.fetch = (url, opts = {}) => {
    const p = realFetch(url, opts);
    p.then(resp => {
      try {
        if (typeof url === 'string' && url.includes('chat/completions') && resp.ok) {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            // Non-streaming: read a clone (small body).
            track(resp.clone().json().then(data => {
              if (data.usage) captured.push({ kind: 'json', usage: data.usage });
            }).catch(() => {}));
          } else if (resp.body) {
            // SSE: clone (independent reader) — the harness reads the original.
            doProbe(resp.clone());
          }
        }
      } catch { /* capture is best-effort */ }
    }).catch(() => {});
    return p; // caller gets the ORIGINAL promise — zero extra microtasks
  };
  // Resolve once every in-flight SSE inspection has settled (or timeout).
  const waitCaptured = async (timeoutMs = 10000) => {
    const t0 = Date.now();
    while (pendingInspections.size > 0 && Date.now() - t0 < timeoutMs) {
      await sleep(50);
    }
  };

  async function submit(text) {
    input.value = text;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 1200; i++) {
      if (!input.disabled) break;
      await sleep(50);
    }
    if (input.disabled) throw new Error('turn did not complete: ' + text);
    await sleep(300);
  }

  try {
    // Read the active session from the DOM, NOT a DB op. A DB op in this fiber
    // before the turn, combined with the fetch wrapper, trips the JSPI +
    // IDBBatchAtomicVFS fiber-resumption race and hangs the turn at its first
    // DB op (empirically confirmed 2026-08-14). The value is informational only.
    const active = document.getElementById('session-select')?.value || null;
    R.steps.activeSession = active;

    captured.length = 0;
    await submit('Reply with exactly: OK-A');
    await waitCaptured(); // let the fire-and-forget SSE inspection settle
    const turn1 = captured.slice();

    captured.length = 0;
    await submit('Reply with exactly: OK-B');
    await waitCaptured();
    const turn2 = captured.slice();

    const pick = (list) => {
      // The LAST call of the turn is the final answer (largest prompt).
      let best = null;
      for (const c of list) {
        if (!best || (c.usage.prompt_tokens || 0) >= (best.usage.prompt_tokens || 0)) best = c;
      }
      return best;
    };
    const u1 = pick(turn1)?.usage || {};
    const u2 = pick(turn2)?.usage || {};
    const cached2 = u2.prompt_tokens_details?.cached_tokens
      ?? u2.prompt_cache?.cached_tokens
      ?? 0;

    R.steps.turn1 = { calls: turn1.length, promptTokens: u1.prompt_tokens, cached: u1.prompt_tokens_details?.cached_tokens ?? null };
    R.steps.turn2 = {
      calls: turn2.length,
      promptTokens: u2.prompt_tokens,
      cachedTokens: cached2,
      raw: u2,
    };
    // The cache hit is on the SHARED PREFIX: turn 2's prompt is strictly
    // larger than turn 1's (it contains turn 1's exchange), and a non-trivial
    // fraction of it was served from the provider cache.
    R.ok = turn1.length > 0 && turn2.length > 0
      && (u2.prompt_tokens || 0) > (u1.prompt_tokens || 0)
      && cached2 > 0;
  } catch (e) {
    R.fatal = e.name + ': ' + e.message;
    R.stack = String(e.stack).slice(0, 800);
  } finally {
    window.fetch = realFetch;
    window.__t2cacheResult = R;
  }
  return R;
}
