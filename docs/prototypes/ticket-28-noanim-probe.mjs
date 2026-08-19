// T28 probe — verify the per-node no-anim suppression actually prevents the
// .message fadeIn on swapped-in nodes (the class-toggle-around-replaceChildren
// approach was probed and FAILED: the animation starts the moment the
// suppression is removed, even in the same task).
//
// Usage (preview browser console or evaluate):
//   import('/docs/prototypes/ticket-28-noanim-probe.mjs?t=' + Date.now())
// then poll window.__t28noanim until done.
export async function runNoAnimProbe() {
  const out = { done: false };
  window.__t28noanim = out;
  if (!(window.__agent && window.__agent.ready)) {
    out.done = true;
    out.error = 'agent not ready';
    return out;
  }
  const m = document.getElementById('messages');
  const prevChildren = m.childElementCount;

  const el = document.createElement('div');
  el.className = 'message assistant no-anim';
  const frag = document.createDocumentFragment();
  frag.appendChild(el);
  m.replaceChildren(frag);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));

  out.name = getComputedStyle(el).animationName;
  out.running = el.getAnimations().length;
  out.opacity = getComputedStyle(el).opacity;

  el.remove();
  m.replaceChildren(); // restore: the app re-renders from the DB
  await window.__agent.renderMessages();
  out.restoredChildren = m.childElementCount;
  out.prevChildren = prevChildren;
  out.done = true;
  return out;
}

runNoAnimProbe().catch((e) => { window.__t28noanim = { done: true, error: String(e) }; });
