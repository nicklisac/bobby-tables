/**
 * PANE RESIZERS — T11 follow-up: draggable dividers between the 3 workstation
 * panes. The left divider resizes #explorer-pane, the right divider resizes
 * #canvas-pane; #center-pane (flex: 1) absorbs the difference.
 *
 * Widths persist in localStorage — this is pure UI state, never agent state
 * (it does not touch the brain DB, v_active_context, or cartridge export).
 * Double-click a divider to reset that pane to its default width.
 *
 * Resizing is allowed while a turn is in flight (it is layout-only, no DB
 * work), so it is intentionally NOT gated by the grid busy state.
 */

const STORAGE_KEY = 'bobby.paneWidths.v1';

const DEFAULTS = { explorer: 250, canvas: 440 };
const MIN = { explorer: 160, canvas: 260 };
// Max as a fraction of the workstation width, so the center pane stays usable.
const MAX_FRACTION = { explorer: 0.45, canvas: 0.5 };

function loadWidths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      explorer: Number.isFinite(p.explorer) ? p.explorer : DEFAULTS.explorer,
      canvas: Number.isFinite(p.canvas) ? p.canvas : DEFAULTS.canvas,
    };
  } catch {
    return { ...DEFAULTS }; // corrupt value / storage unavailable
  }
}

function saveWidths(widths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch { /* storage full/unavailable — resizing still works, just not persisted */ }
}

function applyWidths(widths) {
  const explorer = document.getElementById('explorer-pane');
  const canvas = document.getElementById('canvas-pane');
  if (explorer) explorer.style.width = `${widths.explorer}px`;
  if (canvas) canvas.style.width = `${widths.canvas}px`;
}

/** Attach drag handlers to both dividers and restore persisted widths. */
export function initPaneResizers() {
  const workstation = document.getElementById('workstation');
  if (!workstation) return;

  const dividers = [
    { el: document.getElementById('divider-explorer'), key: 'explorer' },
    { el: document.getElementById('divider-canvas'), key: 'canvas' },
  ].filter(d => d.el);
  if (!dividers.length) return;

  const widths = loadWidths();
  applyWidths(widths);

  for (const { el, key } of dividers) {
    // Double-click resets this pane to its default width.
    el.addEventListener('dblclick', () => {
      widths[key] = DEFAULTS[key];
      applyWidths(widths);
      saveWidths(widths);
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // left button only
      e.preventDefault();
      // Capture the pointer so the drag keeps tracking even when the cursor
      // leaves the 6px strip; fall back to window listeners if capture is
      // unavailable (synthetic events, exotic pointers).
      let captured = false;
      try { el.setPointerCapture(e.pointerId); captured = true; } catch { /* fall through */ }
      const target = captured ? el : window;
      el.classList.add('active');
      document.body.classList.add('pane-resizing');

      const onMove = (ev) => {
        const rect = workstation.getBoundingClientRect();
        const max = rect.width * MAX_FRACTION[key];
        // Left divider: pane width = cursor distance from the workstation's
        // left edge. Right divider: distance from the right edge.
        const raw = key === 'explorer'
          ? ev.clientX - rect.left
          : rect.right - ev.clientX;
        widths[key] = Math.round(Math.min(Math.max(raw, MIN[key]), max));
        applyWidths(widths);
      };

      const onUp = (ev) => {
        if (captured && el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        el.classList.remove('active');
        document.body.classList.remove('pane-resizing');
        saveWidths(widths);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    });
  }
}
