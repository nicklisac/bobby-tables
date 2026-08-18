/**
 * SESSIONS UI — left-pane double accordion: session list, create, rename,
 * delete, switch.
 *
 * [T26.3: moved verbatim from main.js. main.js passes its mutable state
 * (agent, active session id) via initSessionsUi() — no behavior change.]
 */

import {
  listSessions, createSession, renameSession, deleteSession, setActiveSession,
} from './schema.js';
import { escapeHtml } from './utils.js';
import { renderMessages, resetStreamingState } from './chat-render.js';
import { ICONS } from './icons.js';

// ── Init context (wired once by main.js at boot) ─────────────────────

let ctx = null;

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {() => string} context.getSessionId - active session id
 * @param {(id: string) => void} context.setSessionId - set the active session id (main.js state)
 */
export function initSessionsUi(context) {
  ctx = context;
}

/**
 * Rebuild the session list in the left pane. Exported: the cartridge import
 * handler (cartridge.js) refreshes the dropdown after a brain swap.
 */
export async function populateSessionDropdown() {
  const agent = ctx.getAgent();
  if (!agent) return;
  const sessions = await listSessions(agent.sqlite3, agent.db);

  const sessionListEl = document.getElementById('session-list');
  if (sessionListEl) {
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      sessionListEl.innerHTML = '<div class="explorer-empty" style="padding: 0.5rem; font-size: 0.7rem; color: var(--text-muted);">No sessions</div>';
    } else {
      sessions.forEach(s => {
        const item = document.createElement('div');
        const isActive = (s.id === ctx.getSessionId());
        const displayName = (s.name && s.name.trim()) ? s.name.trim() : (s.id === 'default' ? 'Default Session' : s.id);
        item.className = `session-item ${isActive ? 'active' : ''}`;
        item.dataset.sessionId = s.id;
        item.dataset.sessionName = displayName;
        item.innerHTML = `
          <div class="session-item-main" title="${escapeHtml(displayName)} [${escapeHtml(s.id)}] (double-click to rename)">
            <span class="session-item-icon">${ICONS.messageSquare({ size: 13 })}</span>
            <span class="session-item-name">${escapeHtml(displayName)}</span>
          </div>
          <div class="session-item-actions">
            <button type="button" class="btn-session-item-action btn-session-item-rename" data-session-id="${escapeHtml(s.id)}" data-session-name="${escapeHtml(displayName)}" title="Rename session">
              ${ICONS.edit({ size: 11 })}
            </button>
            ${s.id !== 'default' ? `
            <button type="button" class="btn-session-item-action btn-session-item-delete" data-session-id="${escapeHtml(s.id)}" data-session-name="${escapeHtml(displayName)}" title="Delete session">
              ${ICONS.close({ size: 11 })}
            </button>` : ''}
          </div>
        `;
        sessionListEl.appendChild(item);
      });
    }
  }
}

// ── Left Pane Double Accordion & Session Handlers ───────────────────

document.querySelectorAll('.accordion-header').forEach(header => {
  header.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select')) return;
    const section = header.closest('.accordion-section');
    if (!section) return;
    section.classList.toggle('is-open');
  });
});

document.getElementById('btn-new-session')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const agent = ctx.getAgent();
  if (!agent) return;
  const name = prompt('Session name:', 'New Session');
  if (!name?.trim()) return;
  const btn = document.getElementById('btn-new-session');
  if (btn) btn.disabled = true;
  try {
    const id = await createSession(agent.sqlite3, agent.db, name.trim());
    ctx.setSessionId(id);
    resetStreamingState();
    await setActiveSession(agent.sqlite3, agent.db, id);
    await populateSessionDropdown();
    await renderMessages();
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById('session-list')?.addEventListener('click', async (e) => {
  const agent = ctx.getAgent();
  // 1. Rename session action
  const renameBtn = e.target.closest('.btn-session-item-rename');
  if (renameBtn) {
    e.stopPropagation();
    const id = renameBtn.dataset.sessionId;
    const currName = renameBtn.dataset.sessionName || '';
    if (!id || !agent) return;
    const newName = prompt(`Rename session:`, currName);
    if (!newName?.trim() || newName.trim() === currName) return;
    try {
      await renameSession(agent.sqlite3, agent.db, id, newName.trim());
      await populateSessionDropdown();
    } catch (err) {
      alert(`Failed to rename session: ${err.message}`);
    }
    return;
  }

  // 2. Delete session action
  const deleteBtn = e.target.closest('.btn-session-item-delete');
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.sessionId;
    const name = deleteBtn.dataset.sessionName || id;
    if (id === 'default' || !agent) return;
    if (!confirm(`Delete session "${name}" and all its messages?`)) return;
    try {
      await deleteSession(agent.sqlite3, agent.db, id);
      if (ctx.getSessionId() === id) {
        ctx.setSessionId('default');
        resetStreamingState();
        await setActiveSession(agent.sqlite3, agent.db, 'default');
      }
      await populateSessionDropdown();
      await renderMessages();
    } catch (err) {
      alert(`Failed to delete session: ${err.message}`);
    }
    return;
  }

  // 3. Switch session action
  const item = e.target.closest('.session-item');
  if (!item || !agent) return;
  const id = item.dataset.sessionId;
  if (!id || id === ctx.getSessionId()) return;
  ctx.setSessionId(id);
  resetStreamingState();
  await setActiveSession(agent.sqlite3, agent.db, id);
  await populateSessionDropdown();
  await renderMessages();
});

// Double-click session name to rename
document.getElementById('session-list')?.addEventListener('dblclick', async (e) => {
  const agent = ctx.getAgent();
  const item = e.target.closest('.session-item');
  if (!item || !agent) return;
  const id = item.dataset.sessionId;
  const currName = item.dataset.sessionName || '';
  if (!id) return;
  const newName = prompt(`Rename session:`, currName);
  if (!newName?.trim() || newName.trim() === currName) return;
  try {
    await renameSession(agent.sqlite3, agent.db, id, newName.trim());
    await populateSessionDropdown();
  } catch (err) {
    alert(`Failed to rename session: ${err.message}`);
  }
});
