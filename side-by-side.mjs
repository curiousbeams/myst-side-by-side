/**
 * side-by-side: a MyST directive + transforms for rendering two related
 * documents (e.g. an original and its translation) in linked, scrollable
 * panels.
 *
 * Anatomy (see side_by_side_widget.mjs for the client half):
 *
 *   {side-by-side} directive (parse time)
 *     └─ div.side-by-side
 *        ├─ div.sbs-panel.sbs-old → include node (resolved by MyST itself)
 *        ├─ div.sbs-panel.sbs-new → include node
 *        └─ anywidget node (client-side controller)
 *
 *   side-by-side-hooks (document stage): pairs `X.old`/`X_old` labels with
 *   `X.new`/`X_new` labels per container, warns about unmatched hooks,
 *   excludes new-side/unpaired equations and figures from global numbering,
 *   renumbers footnotes per panel (1..n each, like standalone documents) and
 *   renders each panel's footnotes at the bottom of that panel.
 *
 *   side-by-side-equations (project stage, i.e. after global enumeration):
 *   mirrors each old-side equation/figure number onto its new-side twin,
 *   injects the caption number for mirrored figures, and patches references
 *   that target new-side labels.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOOK_RE = /^(.+)[._](old|new)$/;
const WIDGET_CLASS = 'side-by-side';

/** Client widget fallback when no local copy is present: fetched and cached
 * by MyST at build time, so a clean build always pulls the latest version.
 * Pin by replacing `main` with a tag or commit SHA. */
const WIDGET_FILE = 'side_by_side_widget.mjs';
const REMOTE_WIDGET_ESM = `https://raw.githubusercontent.com/curiousbeams/myst-side-by-side/main/${WIDGET_FILE}`;

/** Resolution order: explicit :widget: option; a side_by_side_widget.mjs
 * sitting next to the current page; the published module on GitHub. */
function resolveWidgetEsm(opts, vfile) {
  if (opts.widget) return opts.widget;
  try {
    if (vfile.path && fs.existsSync(path.join(path.dirname(vfile.path), WIDGET_FILE))) {
      return `./${WIDGET_FILE}`;
    }
  } catch {
    // fall through to the remote module
  }
  return REMOTE_WIDGET_ESM;
}

/** Replica of myst-common's createHtmlId, used as a fallback when a hook
 * node has no html_id assigned (the DOM id is what the client widget needs). */
function createHtmlId(identifier) {
  if (!identifier) return undefined;
  return identifier
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^([0-9-])/, 'id-$1')
    .replace(/-[-]+/g, '-')
    .replace(/(?:^[-]+)|(?:[-]+$)/g, '');
}

function htmlIdOf(node) {
  return node.html_id ?? createHtmlId(node.identifier);
}

function basename(file) {
  return String(file).split('/').pop();
}

function hasClass(node, className) {
  return (
    node.type === 'div' &&
    typeof node.class === 'string' &&
    node.class.split(/\s+/).includes(className)
  );
}

function findContainers(tree, utils) {
  return utils.selectAll('div', tree).filter((node) => hasClass(node, WIDGET_CLASS));
}

function findPanel(container, utils, side) {
  return utils.selectAll('div', container).find((node) => hasClass(node, `sbs-${side}`));
}

/** All hook-labeled nodes (paragraphs, equations, figures, ...) in a panel,
 * in document order. Footnotes follow the same label contract but are
 * handled separately (they have no rendered position to scroll to). */
function collectHooks(panel, utils, side) {
  const hooks = [];
  for (const node of utils.selectAll('[identifier]', panel)) {
    if (node.type === 'footnoteDefinition' || node.type === 'footnoteReference') continue;
    const match = typeof node.identifier === 'string' && node.identifier.match(HOOK_RE);
    if (match && match[2] === side) hooks.push({ stem: match[1], node });
  }
  return hooks;
}

function pairHooks(oldHooks, newHooks, warn) {
  const oldByStem = new Map(oldHooks.map((h) => [h.stem, h]));
  const newByStem = new Map(newHooks.map((h) => [h.stem, h]));
  const pairs = [];
  // Unpaired figures/tables are legitimate (a translation may drop or add
  // figures; they get their own side-tagged number), so don't warn on them.
  const warnable = (node) => node.type !== 'container';
  for (const hook of oldHooks) {
    const partner = newByStem.get(hook.stem);
    if (partner) {
      pairs.push({ stem: hook.stem, old: hook.node, new: partner.node });
    } else if (warn && warnable(hook.node)) {
      warn(`hook "${hook.node.identifier}" has no "${hook.stem}(.|_)new" counterpart`, hook.node);
    }
  }
  if (warn) {
    for (const hook of newHooks) {
      if (!oldByStem.has(hook.stem) && warnable(hook.node)) {
        warn(`hook "${hook.node.identifier}" has no "${hook.stem}(.|_)old" counterpart`, hook.node);
      }
    }
  }
  return pairs;
}

function analyzeContainer(container, utils, warn) {
  const oldPanel = findPanel(container, utils, 'old');
  const newPanel = findPanel(container, utils, 'new');
  const widget = (container.children ?? []).find((node) => node.type === 'anywidget');
  if (!oldPanel || !newPanel) return undefined;
  const oldHooks = collectHooks(oldPanel, utils, 'old');
  const newHooks = collectHooks(newPanel, utils, 'new');
  const pairs = pairHooks(oldHooks, newHooks, warn);
  return { oldPanel, newPanel, widget, pairs };
}

function updateWidgetModel(widget, values) {
  if (!widget) return;
  widget.model = { ...widget.model, ...values };
}

function setWidgetPairs(widget, pairs) {
  updateWidgetModel(widget, {
    pairs: pairs.map((p) => [htmlIdOf(p.old), htmlIdOf(p.new)]),
  });
}

/**
 * Side-tagged numbering for figures/tables inside the panels. Every labeled
 * container consumes one slot X from a page-wide, per-kind counter; a
 * matched pair shares its X, displayed as "Figure O.X" / "Figure N.X".
 * Slots are allocated by walking the two panels in step (a merge walk), so
 * a figure inserted on one side takes its slot at its actual position and
 * both panels stay monotonic — pairing then shows up as a gap on the other
 * side (O.1, O.3 across from N.1, N.2, N.3 means the old document has no
 * counterpart to N.2). Pairs whose relative order differs between the
 * panels fall back to old-side order. Because the enumerator is set before
 * MyST's global enumeration (with `enumerated: false`, so the host page's
 * own counters are untouched), caption numbers and cross-references resolve
 * natively. Unlabeled panel containers stay unnumbered — they cannot be
 * cross-referenced anyway.
 */
function tagPanelContainers(info, utils, kindCounts) {
  const partners = new Map(
    info.pairs
      .filter((pair) => pair.old.type === 'container' && pair.new.type === 'container')
      .map((pair) => [pair.old, pair.new]),
  );
  const pairedNew = new Set(partners.values());
  const kindOf = (node) => node.kind ?? 'figure';
  const nextSlot = (kind) => {
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    return kindCounts[kind];
  };
  const tag = (node, side, slot) => {
    node.enumerated = false;
    node.enumerator = `${side}.${slot}`;
  };
  const olds = utils.selectAll('container', info.oldPanel).filter((node) => node.identifier);
  const news = utils.selectAll('container', info.newPanel).filter((node) => node.identifier);
  for (const kind of new Set([...olds, ...news].map(kindOf))) {
    const oldQueue = olds.filter((node) => kindOf(node) === kind);
    const newQueue = news.filter((node) => kindOf(node) === kind);
    let i = 0;
    let j = 0;
    while (i < oldQueue.length || j < newQueue.length) {
      const oldNode = oldQueue[i];
      const newNode = newQueue[j];
      // Already tagged through its partner (including crossed-order pairs).
      if (newNode && newNode.enumerator != null && pairedNew.has(newNode)) {
        j += 1;
      } else if (oldNode && !partners.has(oldNode)) {
        tag(oldNode, 'O', nextSlot(kind));
        i += 1;
      } else if (newNode && !pairedNew.has(newNode)) {
        tag(newNode, 'N', nextSlot(kind));
        j += 1;
      } else if (oldNode && partners.get(oldNode) === newNode) {
        const slot = nextSlot(kind);
        tag(oldNode, 'O', slot);
        tag(newNode, 'N', slot);
        i += 1;
        j += 1;
      } else if (oldNode) {
        // Crossed pair order: number at the old-side position; the partner
        // is skipped when the walk reaches it.
        const slot = nextSlot(kind);
        tag(oldNode, 'O', slot);
        const partner = partners.get(oldNode);
        if (partner) tag(partner, 'N', slot);
        i += 1;
      } else {
        j += 1;
      }
    }
  }
}

/** Footnotes in a panel: definitions plus a stable ordering (first-reference
 * order, then unreferenced definitions in tree order). */
function collectPanelFootnotes(panel, utils) {
  const definitions = new Map(
    utils.selectAll('footnoteDefinition', panel).map((def) => [def.identifier, def]),
  );
  const order = [];
  for (const ref of utils.selectAll('footnoteReference', panel)) {
    if (definitions.has(ref.identifier) && !order.includes(ref.identifier)) {
      order.push(ref.identifier);
    }
  }
  for (const identifier of definitions.keys()) {
    if (!order.includes(identifier)) order.push(identifier);
  }
  return { definitions, order };
}

/** Plain-text content of a node (whitespace-normalized), for comparing
 * auto-generated reference text against a figure caption. */
function textOf(node, utils) {
  return utils
    .selectAll('text', node)
    .map((text) => text.value ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

const sideBySideDirective = {
  name: 'side-by-side',
  doc: 'Render two related MyST documents side-by-side with hook-linked navigation.',
  options: {
    old: {
      type: String,
      required: true,
      doc: 'Path to the old/original document, relative to this page (like {include}).',
    },
    new: {
      type: String,
      required: true,
      doc: 'Path to the new/translated document, relative to this page (like {include}).',
    },
    'max-height': {
      type: String,
      alias: ['max_height'],
      doc: 'Maximum panel height (any CSS length). Default: none.',
    },
    split: {
      type: String,
      alias: ['proportional-width', 'proportional_width'],
      doc: 'Initial width of the old (left) panel, e.g. "30%". Default: 50%. The divider is draggable.',
    },
    highlight: {
      type: Boolean,
      doc: 'Flash the paired block after a click-to-jump. Default: true.',
    },
    'old-title': {
      type: String,
      alias: ['old_title'],
      doc: 'Header title for the old panel. Default: the file name.',
    },
    'new-title': {
      type: String,
      alias: ['new_title'],
      doc: 'Header title for the new panel. Default: the file name.',
    },
    widget: {
      type: String,
      doc: 'Path or URL of the side-by-side anywidget ESM module. Default: side_by_side_widget.mjs next to this page if present, otherwise the published module on GitHub.',
    },
    class: {
      type: String,
      doc: 'Extra CSS classes for the container.',
    },
  },
  run(data, vfile) {
    const opts = data.options ?? {};
    if (!opts.old || !opts.new) {
      const message = vfile.message('side-by-side: both :old: and :new: file paths are required');
      message.fatal = true;
      return [];
    }
    const line = data.node.position?.start?.line ?? 0;
    // Deterministic and unique project-wide: two pages can easily have a
    // directive on the same line, so include the page name in the label.
    const pageStem = createHtmlId(basename(vfile.path ?? 'page').replace(/\.[^.]+$/, '')) ?? 'page';
    const label = `side-by-side-${pageStem}-l${line}`;
    const extraClass = opts.class ? ` ${opts.class}` : '';
    return [
      {
        type: 'div',
        class: `${WIDGET_CLASS}${extraClass}`,
        label,
        identifier: label,
        html_id: createHtmlId(label),
        children: [
          {
            type: 'div',
            class: 'sbs-panel sbs-old',
            children: [{ type: 'include', file: opts.old }],
          },
          {
            type: 'div',
            class: 'sbs-panel sbs-new',
            children: [{ type: 'include', file: opts.new }],
          },
          {
            type: 'anywidget',
            esm: resolveWidgetEsm(opts, vfile),
            id: `${label}-widget`,
            model: {
              container: createHtmlId(label),
              split: opts.split ?? '50%',
              maxHeight: opts['max-height'] ?? 'none',
              highlight: opts.highlight ?? true,
              oldTitle: opts['old-title'] ?? basename(opts.old),
              newTitle: opts['new-title'] ?? basename(opts.new),
              pairs: [],
              footnoteMarkers: [],
              commentMarkers: [],
            },
          },
        ],
      },
    ];
  },
};

const sideBySideHooksTransform = {
  name: 'side-by-side-hooks',
  doc: 'Pair old/new hooks in side-by-side containers, validate coverage, and prepare numbering.',
  stage: 'document',
  plugin: (_, utils) => (tree, vfile) => {
    const containers = findContainers(tree, utils);
    if (containers.length === 0) return;
    const warn = (reason, node) => {
      const message = vfile.message(`side-by-side: ${reason}`, node);
      message.fatal = false;
    };
    const processedFootnotes = new Set();
    const containerKindCounts = {};
    let pairCount = 0;
    const pageMarkers = [];
    const pageComments = [];
    let commentCount = 0;
    const nextCommentMarker = () => {
      commentCount += 1;
      return `C.${commentCount}`;
    };
    const widgets = [];
    for (const container of containers) {
      const info = analyzeContainer(container, utils, warn);
      if (!info) continue;
      if (info.widget) widgets.push(info.widget);
      const pairedStems = new Set(info.pairs.map((p) => p.stem));
      // Old-side equations that are part of a pair keep their place in the
      // global numbering (mirrored onto the new side at project stage);
      // other panel equations are unnumbered, as is conventional.
      for (const node of utils.selectAll('math', info.oldPanel)) {
        const match = typeof node.identifier === 'string' && node.identifier.match(HOOK_RE);
        const paired = match && match[2] === 'old' && pairedStems.has(match[1]);
        if (!paired) node.enumerated = false;
      }
      for (const node of utils.selectAll('math', info.newPanel)) {
        node.enumerated = false;
      }
      // Figures/tables always deserve a number; tag them by side.
      tagPanelContainers(info, utils, containerKindCounts);
      // Footnotes follow the same .old/.new label contract: matched labels
      // are a translated pair and share a number (O.X / N.X, X continuing
      // across containers on the page); anything else is a translator
      // comment (C.1, C.2, ... in document order). Markers show on the
      // in-text references and restyle the page-footer list; hover popovers
      // are unaffected.
      const oldFootnotes = collectPanelFootnotes(info.oldPanel, utils);
      const newFootnotes = collectPanelFootnotes(info.newPanel, utils);
      const newByStem = new Map();
      for (const identifier of newFootnotes.order) {
        const match = identifier.match(HOOK_RE);
        if (match && match[2] === 'new') newByStem.set(match[1], identifier);
      }
      for (const identifier of oldFootnotes.order) {
        const def = oldFootnotes.definitions.get(identifier);
        if (processedFootnotes.has(def)) continue;
        processedFootnotes.add(def);
        const match = identifier.match(HOOK_RE);
        const partnerId = match && match[2] === 'old' ? newByStem.get(match[1]) : undefined;
        const partner = partnerId ? newFootnotes.definitions.get(partnerId) : undefined;
        if (partner && !processedFootnotes.has(partner)) {
          processedFootnotes.add(partner);
          pairCount += 1;
          def.enumerator = `O.${pairCount}`;
          partner.enumerator = `N.${pairCount}`;
          pageMarkers.push([def.identifier, def.enumerator], [partner.identifier, partner.enumerator]);
        } else {
          def.enumerator = nextCommentMarker();
          pageComments.push([def.identifier, def.enumerator]);
        }
      }
      for (const identifier of newFootnotes.order) {
        const def = newFootnotes.definitions.get(identifier);
        if (processedFootnotes.has(def)) continue;
        processedFootnotes.add(def);
        def.enumerator = nextCommentMarker();
        pageComments.push([def.identifier, def.enumerator]);
      }
      for (const [panel, { definitions }] of [
        [info.oldPanel, oldFootnotes],
        [info.newPanel, newFootnotes],
      ]) {
        for (const ref of utils.selectAll('footnoteReference', panel)) {
          const def = definitions.get(ref.identifier);
          if (def?.enumerator) ref.enumerator = def.enumerator;
        }
      }
      setWidgetPairs(info.widget, info.pairs);
    }
    // Panel footnotes consumed numbers from the page-wide sequence; renumber
    // the remaining (host page) footnotes cleanly as 1..k.
    const hostDefinitions = new Map(
      utils
        .selectAll('footnoteDefinition', tree)
        .filter((def) => !processedFootnotes.has(def))
        .map((def) => [def.identifier, def]),
    );
    let hostCount = 0;
    for (const ref of utils.selectAll('footnoteReference', tree)) {
      const def = hostDefinitions.get(ref.identifier);
      if (!def) continue;
      if (!processedFootnotes.has(def)) {
        processedFootnotes.add(def);
        hostCount += 1;
        def.enumerator = String(hostCount);
        pageMarkers.push([def.identifier, def.enumerator]);
      }
      ref.enumerator = def.enumerator;
    }
    // Every widget on the page gets the full marker maps; the first one to
    // mount restyles the footer list and builds the Comments section from
    // the rendered footer entries.
    for (const widget of widgets) {
      updateWidgetModel(widget, { footnoteMarkers: pageMarkers, commentMarkers: pageComments });
    }
  },
};

const sideBySideEquationsTransform = {
  name: 'side-by-side-equations',
  doc: 'Mirror old-side equation numbers onto new-side counterparts after global enumeration.',
  stage: 'project',
  plugin: (_, utils) => (tree) => {
    const mirrored = new Map(); // new-side identifier -> enumerator
    for (const container of findContainers(tree, utils)) {
      const info = analyzeContainer(container, utils, undefined);
      if (!info) continue;
      for (const pair of info.pairs) {
        if (pair.old.type !== 'math' || pair.new.type !== 'math') continue;
        if (pair.old.enumerator == null) continue;
        pair.new.enumerator = pair.old.enumerator;
        if (pair.new.identifier) mirrored.set(pair.new.identifier, pair.old.enumerator);
      }
      // Re-sync the widget pair map now that html_ids are final.
      setWidgetPairs(info.widget, info.pairs);
    }
    if (mirrored.size === 0) return;
    // References to new-side equations resolved before the mirror above,
    // while the target was still unnumbered, so they were rendered with the
    // named template (plain "Equation") instead of the numbered "(%s)".
    // Upgrade auto-generated reference text; leave custom link text alone.
    for (const xref of utils.selectAll('crossReference', tree)) {
      const enumerator = mirrored.get(xref.identifier);
      if (enumerator == null) continue;
      xref.enumerator = enumerator;
      const joined = textOf(xref, utils);
      const autoGenerated =
        joined.length === 0 ||
        joined === 'Equation' ||
        joined.includes('%s') ||
        joined.includes('??');
      if (autoGenerated) {
        xref.template = '(%s)';
        xref.children = [{ type: 'text', value: `(${enumerator})` }];
        xref.resolved = true;
      }
    }
  },
};

const plugin = {
  name: 'Side-by-side translation view',
  directives: [sideBySideDirective],
  transforms: [sideBySideHooksTransform, sideBySideEquationsTransform],
};

export default plugin;
