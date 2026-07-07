/**
 * Client half of the side-by-side directive (see side-by-side.mjs).
 *
 * Loaded through MyST's {anywidget} node renderer. The widget's own host
 * element is hidden; instead it decorates the light-DOM container the
 * directive emitted (div.side-by-side with two div.sbs-panel children):
 * flex layout, sticky panel headers with minimize buttons, a draggable
 * divider, and hook-linked click-to-jump between the panels.
 */

const STYLE_ID = 'sbs-global-styles';

const GLOBAL_CSS = `
.side-by-side.sbs-active {
  display: flex;
  align-items: stretch;
  margin: 1rem 0;
  border: 1px solid rgba(127, 127, 127, 0.35);
  border-radius: 0.375rem;
  overflow: hidden;
}
.sbs-active > .sbs-panel {
  position: relative;
  overflow-y: auto;
  overflow-x: auto;
  max-height: var(--sbs-max-height, 500px);
  padding: 0 1rem 0.75rem;
  min-width: 0;
}
.sbs-active > .sbs-old { order: 1; flex: 0 0 var(--sbs-split, 50%); }
.sbs-active > .sbs-new { order: 3; flex: 1 1 0; }
.sbs-active.sbs-collapsed-old > .sbs-old,
.sbs-active.sbs-collapsed-new > .sbs-new { flex: 0 0 2.5rem; overflow: hidden; }
.sbs-active.sbs-collapsed-new > .sbs-old { flex: 1 1 0; }
.sbs-active > .sbs-divider {
  order: 2;
  flex: 0 0 6px;
  cursor: col-resize;
  background: rgba(127, 127, 127, 0.2);
  user-select: none;
  touch-action: none;
}
.sbs-active > .sbs-divider:hover,
.sbs-active.sbs-dragging > .sbs-divider { background: rgba(127, 127, 127, 0.5); }
.sbs-active.sbs-collapsed-old > .sbs-divider,
.sbs-active.sbs-collapsed-new > .sbs-divider { cursor: default; }
.sbs-active.sbs-dragging { cursor: col-resize; user-select: none; }
.sbs-active.sbs-dragging > .sbs-panel { pointer-events: none; }
.sbs-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0 -1rem 0.75rem;
  padding: 0.3rem 0.75rem;
  border-bottom: 1px solid rgba(127, 127, 127, 0.35);
  background: rgba(127, 127, 127, 0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 0.8rem;
  font-weight: 600;
}
.sbs-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.sbs-min-btn {
  flex: 0 0 auto;
  width: 1.4rem;
  height: 1.4rem;
  line-height: 1;
  padding: 0;
  border: 1px solid rgba(127, 127, 127, 0.4);
  border-radius: 0.25rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.9rem;
}
.sbs-min-btn:hover { background: rgba(127, 127, 127, 0.2); }
.sbs-panel.sbs-collapsed > :not(.sbs-header) { display: none; }
.sbs-panel.sbs-collapsed { padding: 0; }
.sbs-panel.sbs-collapsed .sbs-header {
  flex-direction: column-reverse;
  justify-content: flex-end;
  height: 100%;
  margin: 0;
  padding: 0.4rem 0.2rem;
  border-bottom: none;
}
.sbs-panel.sbs-collapsed .sbs-title {
  writing-mode: vertical-rl;
  font-size: 0.75rem;
}
.sbs-flash { animation: sbs-flash 1.6s ease-out 1; }
@keyframes sbs-flash {
  0% { background: rgba(250, 204, 21, 0.45); }
  100% { background: rgba(250, 204, 21, 0); }
}
`;

function ensureGlobalStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = GLOBAL_CSS;
  document.head.appendChild(style);
}

/** Vertical offset of el within an ancestor scroll container. */
function offsetWithin(container, el) {
  let y = 0;
  let node = el;
  while (node && node !== container) {
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return y;
}

function byId(scope, id) {
  return scope.querySelector(`[id="${CSS.escape(id)}"]`);
}

export default {
  render({ model, el }) {
    const get = (key, fallback) => {
      let value;
      try {
        value = model.get(key);
      } catch {
        value = undefined;
      }
      return value === undefined || value === null ? fallback : value;
    };

    // The widget node is a child of the container div; find it from our host
    // element (which may sit inside a shadow root), falling back to the id
    // the directive stored in the model.
    const rootNode = el.getRootNode();
    const host = rootNode instanceof ShadowRoot ? rootNode.host : el;
    let container = host.closest?.('.side-by-side');
    if (!container) {
      const containerId = get('container', '');
      container = containerId ? document.getElementById(containerId) : null;
    }
    if (!container) return undefined;
    const oldPanel = container.querySelector('.sbs-panel.sbs-old');
    const newPanel = container.querySelector('.sbs-panel.sbs-new');
    if (!oldPanel || !newPanel) return undefined;

    ensureGlobalStyles();

    // Re-render safety: clear anything a previous mount injected here.
    container.querySelectorAll('.sbs-injected').forEach((node) => node.remove());
    oldPanel.classList.remove('sbs-collapsed');
    newPanel.classList.remove('sbs-collapsed');

    const split = get('split', '50%');
    container.classList.add('sbs-active');
    container.style.setProperty('--sbs-split', split);
    container.style.setProperty('--sbs-max-height', get('maxHeight', '500px'));

    // Hide the widget's own top-level element inside the container; all the
    // chrome lives in the light DOM so it can sit inside the panels.
    let hostTop = host;
    while (hostTop.parentElement && hostTop.parentElement !== container) {
      hostTop = hostTop.parentElement;
    }
    if (hostTop.parentElement === container) hostTop.style.display = 'none';

    const cleanups = [];
    const listen = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    };

    // --- Panel headers with minimize/restore -------------------------------
    const buttons = new Map(); // panel -> its minimize button
    const collapseClass = (panel) => (panel === oldPanel ? 'sbs-collapsed-old' : 'sbs-collapsed-new');
    const setCollapsed = (panel, collapsed) => {
      panel.classList.toggle('sbs-collapsed', collapsed);
      container.classList.toggle(collapseClass(panel), collapsed);
      const button = buttons.get(panel);
      if (button) {
        button.textContent = collapsed ? '+' : '−';
        button.title = collapsed ? 'Restore panel' : 'Minimize panel';
      }
    };
    const makeHeader = (panel, otherPanel, title) => {
      const header = document.createElement('div');
      header.className = 'sbs-header sbs-injected';
      const label = document.createElement('span');
      label.className = 'sbs-title';
      label.textContent = title;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sbs-min-btn';
      header.append(label, button);
      panel.prepend(header);
      buttons.set(panel, button);
      setCollapsed(panel, false);
      listen(button, 'click', () => {
        const collapsing = !panel.classList.contains('sbs-collapsed');
        setCollapsed(panel, collapsing);
        // Never leave both panels collapsed.
        if (collapsing && otherPanel.classList.contains('sbs-collapsed')) {
          setCollapsed(otherPanel, false);
        }
      });
    };
    makeHeader(oldPanel, newPanel, get('oldTitle', 'Old'));
    makeHeader(newPanel, oldPanel, get('newTitle', 'New'));

    // --- Draggable divider --------------------------------------------------
    const divider = document.createElement('div');
    divider.className = 'sbs-divider sbs-injected';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    container.insertBefore(divider, newPanel);

    let drag = null;
    listen(divider, 'pointerdown', (ev) => {
      if (container.querySelector('.sbs-collapsed')) return;
      drag = { startX: ev.clientX, startWidth: oldPanel.getBoundingClientRect().width };
      divider.setPointerCapture(ev.pointerId);
      container.classList.add('sbs-dragging');
    });
    listen(divider, 'pointermove', (ev) => {
      if (!drag) return;
      const total = container.getBoundingClientRect().width - divider.getBoundingClientRect().width;
      if (total <= 0) return;
      const pct = ((drag.startWidth + ev.clientX - drag.startX) / total) * 100;
      container.style.setProperty('--sbs-split', `${Math.min(85, Math.max(15, pct)).toFixed(1)}%`);
    });
    const endDrag = () => {
      drag = null;
      container.classList.remove('sbs-dragging');
    };
    listen(divider, 'pointerup', endDrag);
    listen(divider, 'pointercancel', endDrag);
    listen(divider, 'dblclick', () => container.style.setProperty('--sbs-split', split));

    // --- Hook-linked click-to-jump ------------------------------------------
    const pairs = get('pairs', []);
    const oldToNew = new Map(pairs.map(([o, n]) => [o, n]));
    const newToOld = new Map(pairs.map(([o, n]) => [n, o]));
    const highlight = get('highlight', true);

    // --- Footnote markers ----------------------------------------------------
    // The transform gave panel footnotes side-tagged enumerators (O.1, N.1,
    // ...) shown on the in-text markers, but the page-footer list numbers
    // its items positionally — replace those markers with the tagged ones.
    const footnoteMarkers = get('footnoteMarkers', []);
    const commentMarkers = get('commentMarkers', []);
    const commentIds = new Set(commentMarkers.map(([id]) => id));
    if (footnoteMarkers.length || commentMarkers.length) {
      const markerStyle = document.createElement('style');
      markerStyle.textContent = [
        // The theme's paragraph reset is scoped to #footnotes; mirror it for
        // the cloned #comments section.
        '#comments p { margin: 0.25rem; }',
        '#footnotes ol, #comments ol { list-style: none; padding-left: 0.25rem; }',
        '#footnotes ol > li, #comments ol > li { display: flex; gap: 0.5rem; }',
        '#footnotes ol > li::before, #comments ol > li::before { content: ""; flex: 0 0 auto; min-width: 1.5rem; font-weight: 600; }',
        ...footnoteMarkers.map(
          ([id, marker]) =>
            `#footnotes li[id="fn-${CSS.escape(id)}"]::before { content: ${JSON.stringify(
              `${marker}.`,
            )}; }`,
        ),
        // Comments move to their own cloned section below the footnotes;
        // hide their entries in the original list.
        ...commentMarkers.flatMap(([id, marker]) => [
          `#footnotes li[id="fn-${CSS.escape(id)}"] { display: none; }`,
          `#comments li[id="comment-fn-${CSS.escape(id)}"]::before { content: ${JSON.stringify(
            `${marker}.`,
          )}; }`,
        ]),
      ].join('\n');
      document.head.appendChild(markerStyle);
      cleanups.push(() => markerStyle.remove());
      requestAnimationFrame(() => {
        const section = document.getElementById('footnotes');
        if (!section) return;
        // Build the Comments section: a clone of the footnotes section (so
        // it inherits the exact theme styling) holding the comment entries.
        if (commentMarkers.length && !document.getElementById('comments')) {
          const clone = section.cloneNode(true);
          clone.id = 'comments';
          const header = clone.querySelector('header');
          if (header) {
            for (const node of header.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                node.nodeValue = 'Comments';
                break;
              }
            }
            const anchor = header.querySelector('a');
            if (anchor) {
              anchor.setAttribute('href', '#comments');
              anchor.setAttribute('title', 'Link to Comments');
              anchor.setAttribute('aria-label', 'Link to Comments');
            }
          }
          const list = clone.querySelector('ol');
          if (list) {
            list.textContent = '';
            for (const [id] of commentMarkers) {
              const original = section.querySelector(`li[id="fn-${CSS.escape(id)}"]`);
              if (!original) continue;
              const item = original.cloneNode(true);
              item.id = `comment-fn-${id}`;
              list.appendChild(item);
            }
          }
          section.after(clone);
          cleanups.push(() => clone.remove());
        }
        // If every remaining entry in the original list is hidden, hide the
        // whole Footnotes section (the Comments clone is unaffected).
        const items = [...section.querySelectorAll('li')];
        if (items.length && items.every((li) => getComputedStyle(li).display === 'none')) {
          section.style.display = 'none';
          cleanups.push(() => {
            section.style.display = '';
          });
        }
      });
    }

    const flash = (target) => {
      target.classList.remove('sbs-flash');
      void target.offsetWidth; // restart the animation
      target.classList.add('sbs-flash');
      target.addEventListener('animationend', () => target.classList.remove('sbs-flash'), {
        once: true,
      });
    };

    const hookElements = (panel, ids) => {
      const found = [];
      for (const id of ids) {
        const hook = byId(panel, id);
        if (hook) found.push(hook);
      }
      return found.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    };

    const jumpFrom = (panel, otherPanel, map) => (ev) => {
      const link = ev.target.closest('a, button');
      if (link) {
        // Comment markers point at their (hidden) footer entry; go to the
        // Comments section instead. Other links keep their default behavior.
        const href = link.getAttribute?.('href') ?? '';
        const fnMatch = href.match(/#fn-(.+)$/);
        const fnId = fnMatch ? decodeURIComponent(fnMatch[1]) : null;
        if (!fnId || !commentIds.has(fnId)) return;
        const item = document.getElementById(`comment-fn-${fnId}`);
        if (!item) return;
        ev.preventDefault();
        ev.stopPropagation();
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (highlight) flash(item);
        return;
      }
      // Nearest hook at or before the click target, in document order.
      let current = null;
      for (const hook of hookElements(panel, [...map.keys()])) {
        const position = hook.compareDocumentPosition(ev.target);
        if (
          hook === ev.target ||
          hook.contains(ev.target) ||
          position & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          current = hook;
        } else {
          break;
        }
      }
      if (!current) return;
      const targetId = map.get(current.id);
      const target = targetId ? byId(otherPanel, targetId) : null;
      if (!target) return;
      if (otherPanel.scrollHeight - otherPanel.clientHeight > 4) {
        const headerHeight = otherPanel.querySelector('.sbs-header')?.offsetHeight ?? 0;
        otherPanel.scrollTo({
          top: Math.max(0, offsetWithin(otherPanel, target) - headerHeight - 8),
          behavior: 'smooth',
        });
      } else {
        // Panel doesn't scroll (e.g. :max-height: none): scroll the page.
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (highlight) flash(target);
    };
    listen(oldPanel, 'click', jumpFrom(oldPanel, newPanel, oldToNew));
    listen(newPanel, 'click', jumpFrom(newPanel, oldPanel, newToOld));

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      container.querySelectorAll('.sbs-injected').forEach((node) => node.remove());
      container.classList.remove('sbs-active', 'sbs-collapsed-old', 'sbs-collapsed-new', 'sbs-dragging');
      oldPanel.classList.remove('sbs-collapsed');
      newPanel.classList.remove('sbs-collapsed');
    };
  },
};
