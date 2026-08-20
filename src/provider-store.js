// T31: Saved provider profiles.
//
// Profiles live in localStorage — deliberately NOT in the brain DB:
// a .sqlite3 cartridge export (T10, VACUUM INTO) must never be able to
// leak API keys. The store is the single source of truth for LLM
// provider configuration; the legacy single-object config
// (localStorage['sql-agent-config']) is migrated one-way on first boot.

const STORE_KEY = 'sql-agent-providers';
const LEGACY_KEY = 'sql-agent-config';

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) return null;
    return { profiles: parsed.profiles, activeId: parsed.activeId || null };
  } catch {
    return null;
  }
}

function writeStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function blankProfile() {
  return {
    id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    name: '',
    provider: 'gemini',
    url: '',
    model: '',
    apiKey: '',
    contextWindow: '',
    maxTokens: '',
  };
}

/**
 * One-way migration of the legacy single-object config into a profile.
 *
 * Keyed on the LEGACY KEY'S PRESENCE, not the store's absence: the app writes
 * an (empty) store on the first unconfigured boot, so a legacy config that
 * appears later must still migrate. Idempotent because the legacy key is
 * deleted the moment it is migrated — a second boot finds no legacy key and
 * is a no-op. Returns the current store.
 */
export function migrateLegacyConfig() {
  const store = readStore() || { profiles: [], activeId: null };
  const legacyRaw = localStorage.getItem(LEGACY_KEY);

  if (legacyRaw) {
    let legacy = null;
    try {
      legacy = JSON.parse(legacyRaw);
    } catch {
      legacy = null;
    }
    if (legacy && legacy.provider) {
      const profile = {
        id: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
        name: legacy.provider,
        provider: legacy.provider,
        url: legacy.url || '',
        model: legacy.model || '',
        apiKey: legacy.apiKey || '',
        contextWindow: legacy.contextWindow || '',
        maxTokens: '',
      };
      store.profiles.push(profile);
      if (!store.activeId) store.activeId = profile.id;
      writeStore(store);
      localStorage.removeItem(LEGACY_KEY);
      return store;
    }
    // Corrupt / provider-less legacy config: drop it rather than boot on a
    // half-parse.
    localStorage.removeItem(LEGACY_KEY);
  }

  writeStore(store);
  return store;
}

export function loadStore() {
  return readStore() || { profiles: [], activeId: null };
}

export function saveStore(store) {
  writeStore(store);
}

export function getActiveProfile() {
  const store = loadStore();
  return store.profiles.find(p => p.id === store.activeId) || null;
}

/** Set the active profile. Returns the updated store, or null if the id is unknown. */
export function setActiveProfile(id) {
  const store = loadStore();
  if (!store.profiles.some(p => p.id === id)) return null;
  store.activeId = id;
  saveStore(store);
  return store;
}

/** Insert or update a profile (matched by id). A first profile becomes active. */
export function upsertProfile(profile) {
  const store = loadStore();
  const idx = store.profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else {
    store.profiles.push(profile);
    if (!store.activeId) store.activeId = profile.id;
  }
  saveStore(store);
  return store;
}

/**
 * Delete a profile. If it was active, activation moves to the first
 * remaining profile (or null when none remain). Returns the updated store.
 */
export function deleteProfile(id) {
  const store = loadStore();
  store.profiles = store.profiles.filter(p => p.id !== id);
  if (store.activeId === id) {
    store.activeId = store.profiles.length ? store.profiles[0].id : null;
  }
  saveStore(store);
  return store;
}

export function newProfile() {
  return blankProfile();
}

/** Mask a key for at-rest display: keep the last 4 chars only. */
export function maskKey(key) {
  if (!key) return '';
  const k = String(key).trim();
  if (k.length <= 4) return '••••';
  return '••••' + k.slice(-4);
}
