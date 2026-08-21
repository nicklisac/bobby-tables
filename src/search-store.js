// T35b: Per-user web-search config (bring-your-own-key).
//
// Lives in localStorage — deliberately NOT in the brain DB and NOT on any
// server: a .sqlite3 cartridge export (T10, VACUUM INTO) must never leak a
// search API key, and a hosted deployment must never burn the host operator's
// credits on every visitor's search. Each user's key stays in their own
// browser and is sent per-request to the same-origin /api/search relay, which
// forwards it to the provider (Exa/Brave don't send CORS headers, so the
// browser can't call them directly — Tavily could, but one relay path keeps
// the UX uniform). The key is never logged or stored server-side.

const STORE_KEY = 'sql-agent-search';

/** Providers the relay understands (must match api/search-providers.mjs). */
export const SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'];

/** Human labels for the config modal. */
export const SEARCH_PROVIDER_LABELS = {
  exa: 'Exa (neural — paid)',
  tavily: 'Tavily (free 1,000/mo, no card)',
  brave: 'Brave (card-gated credits)',
};

/**
 * @returns {{provider: string, apiKey: string} | null} the saved config, or
 *   null when nothing valid is stored.
 */
export function loadSearchConfig() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const provider = SEARCH_PROVIDERS.includes(parsed.provider) ? parsed.provider : null;
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    if (!provider || !apiKey) return null;
    return { provider, apiKey };
  } catch {
    return null;
  }
}

/** Persist a config. Returns true on success, false when invalid. */
export function saveSearchConfig(cfg) {
  if (cfg && SEARCH_PROVIDERS.includes(cfg.provider) && String(cfg.apiKey || '').trim()) {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      provider: cfg.provider,
      apiKey: String(cfg.apiKey).trim(),
    }));
    return true;
  }
  return false;
}

export function clearSearchConfig() {
  localStorage.removeItem(STORE_KEY);
}

/** Mask a key for at-rest display: keep the last 4 chars only. */
export function maskSearchKey(key) {
  if (!key) return '';
  const k = String(key).trim();
  if (k.length <= 4) return '••••';
  return '••••' + k.slice(-4);
}
