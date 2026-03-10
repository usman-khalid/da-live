/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  Plugin,
  PluginKey,
  Decoration,
  DecorationSet,
  NodeSelection,
  CellSelection,
} from 'da-y-wrapper';
import commentService from '../../../da-comments/helpers/comment-service.js';
import { findBestMatchPosition, getPositionContext } from '../../../da-comments/helpers/comment-utils.js';

const commentPluginKey = new PluginKey('comments');

let positionCache = new Map();
let reResolveTimer = null;
let anchorUpdateTimer = null;
let activeThreadId = null;
let hoverThreadId = null;
let pendingRange = null;

function isTableCellNode(node) {
  const role = node?.type?.spec?.tableRole;
  return role === 'cell' || role === 'header_cell';
}

function hasSelectableTableContent(node) {
  if (!node) return false;
  if (node.textContent?.trim()) return true;

  let hasImage = false;
  node.descendants((child) => {
    if (child.type?.name === 'image') {
      hasImage = true;
      return false;
    }
    return !hasImage;
  });
  return hasImage;
}

function buildCellDecorations(state, from, to, attrs) {
  const decorations = [];
  const start = Math.max(0, from - 1);
  const end = Math.min(state.doc.content.size, to + 1);

  state.doc.nodesBetween(start, end, (node, pos) => {
    if (!isTableCellNode(node)) return true;

    const cellFrom = pos + 1;
    const cellTo = pos + node.nodeSize - 1;
    if (from <= cellFrom && to >= cellTo) {
      decorations.push(Decoration.inline(cellFrom, cellTo, attrs));
      node.descendants((child, offset) => {
        if (child.type?.name === 'image') {
          const imagePos = cellFrom + offset;
          decorations.push(Decoration.node(imagePos, imagePos + child.nodeSize, attrs));
          return false;
        }
        return true;
      });
    }
    return false;
  });

  return decorations;
}

function spansTableCells(state, from, to) {
  return buildCellDecorations(state, from, to, {}).length > 0;
}

function isValidRange(state, from, to) {
  return Number.isInteger(from)
    && Number.isInteger(to)
    && from >= 0
    && to <= state.doc.content.size
    && from < to;
}

function matchesBoundaryContext(state, from, to, positionContext) {
  if (!positionContext) return false;

  try {
    const beforeLen = positionContext.textBefore?.length || 0;
    const afterLen = positionContext.textAfter?.length || 0;
    const beforeStart = Math.max(0, from - beforeLen);
    const afterEnd = Math.min(state.doc.content.size, to + afterLen);

    const before = beforeLen ? state.doc.textBetween(beforeStart, from, '', '') : '';
    const after = afterLen ? state.doc.textBetween(to, afterEnd, '', '') : '';

    if (positionContext.textBefore && before !== positionContext.textBefore) return false;
    if (positionContext.textAfter && after !== positionContext.textAfter) return false;
    return beforeLen > 0 || afterLen > 0;
  } catch {
    return false;
  }
}

function findImagePosition(state, comment) {
  const matches = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      const src = node.attrs?.src || '';
      if (comment.imageRef && src.includes(comment.imageRef)) {
        matches.push(pos);
      }
    }
    return true;
  });
  return matches.length === 1 ? matches[0] : null;
}

function getRootForThread(thread) {
  return thread.find((c) => c.parentId === null) || thread[0];
}

function resolveLiveAnchor(state, root) {
  if (root.isImage) {
    if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
      const node = state.doc.nodeAt(root.anchorFrom);
      if (node?.type.name === 'image') {
        return { from: root.anchorFrom, to: root.anchorTo };
      }
    }
    const imgPos = findImagePosition(state, root);
    return imgPos != null ? { from: imgPos, to: imgPos + 1 } : null;
  }
  if (root.isTable) {
    if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
      return { from: root.anchorFrom, to: root.anchorTo };
    }
    return null;
  }

  if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
    const { anchorFrom, anchorTo } = root;
    const text = state.doc.textBetween(anchorFrom, anchorTo, '', '');
    const liveContext = root.anchorContext || root.positionContext;
    if (
      text === root.selectedText
      || matchesBoundaryContext(state, anchorFrom, anchorTo, liveContext)
    ) {
      return { from: anchorFrom, to: anchorTo };
    }
  }

  return null;
}

function resolveSnapshotAnchor(state, root) {
  if (root.isImage || root.isTable || !root.selectedText) return null;
  return findBestMatchPosition(state, root.selectedText, root.positionContext);
}

function anchorComment(state, root) {
  return resolveLiveAnchor(state, root) || resolveSnapshotAnchor(state, root);
}

function mapPositionCache(cache, mapping) {
  const mapped = new Map();
  cache.forEach((range, threadId) => {
    const from = mapping.map(range.from, 1);
    const to = mapping.map(range.to, -1);
    mapped.set(threadId, { from, to });
  });
  return mapped;
}

function buildDecorations(state, cache) {
  const decorations = [];

  cache.forEach((range, threadId) => {
    if (range.from >= range.to) return;

    const isActive = threadId === activeThreadId;
    const isHover = !isActive && threadId === hoverThreadId;
    let cls = 'da-comment-highlight';
    if (isActive) cls += ' da-comment-highlight-active';
    else if (isHover) cls += ' da-comment-highlight-hover';

    const isImage = range.to - range.from === 1;
    if (isImage) {
      try {
        const node = state.doc.nodeAt(range.from);
        if (node?.type.name === 'image') {
          decorations.push(
            Decoration.node(range.from, range.to, {
              class: cls,
              'data-comment-thread': threadId,
            }),
          );
          return;
        }
      } catch { /* nada */ }
    }

    const attrs = {
      class: cls,
      'data-comment-thread': threadId,
    };
    if (spansTableCells(state, range.from, range.to)) {
      decorations.push(...buildCellDecorations(state, range.from, range.to, attrs));
      return;
    }

    decorations.push(Decoration.inline(range.from, range.to, attrs));
  });

  if (pendingRange && pendingRange.from < pendingRange.to) {
    const attrs = { class: 'da-comment-highlight-pending' };
    if (spansTableCells(state, pendingRange.from, pendingRange.to)) {
      decorations.push(...buildCellDecorations(state, pendingRange.from, pendingRange.to, attrs));
    } else {
      decorations.push(Decoration.inline(pendingRange.from, pendingRange.to, attrs));
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

function updateCommentAnchors(state, cache) {
  if (!commentService.initialized || commentService.readOnly) return;

  cache.forEach((range, threadId) => {
    if (range.from >= range.to) return;
    const root = commentService.getRootComment(threadId);
    if (!root) return;

    const anchorContext = getPositionContext(state, range.from, range.to);
    const sameRange = root.anchorFrom === range.from && root.anchorTo === range.to;
    const sameContext = JSON.stringify(root.anchorContext || null)
      === JSON.stringify(anchorContext);
    if (sameRange && sameContext) return;

    commentService.save({
      ...root,
      anchorFrom: range.from,
      anchorTo: range.to,
      anchorContext,
    });
  });
}

function detectOrphans(cache) {
  if (!commentService.initialized) return;

  const newlyOrphanedIds = [];

  commentService.threads.forEach((thread, threadId) => {
    const root = getRootForThread(thread);
    if (!root || root.resolved) return;

    const range = cache.get(threadId);
    const isAnchored = range && range.from < range.to;

    if (!isAnchored && !root.orphaned) {
      commentService.save({ ...root, orphaned: true, orphanedAt: Date.now() });
      newlyOrphanedIds.push(threadId);
    } else if (isAnchored && root.orphaned) {
      const { orphaned, orphanedAt, ...clean } = root;
      commentService.save(clean);
    }
  });

  if (newlyOrphanedIds.length > 0) {
    if (newlyOrphanedIds.includes(activeThreadId)) activeThreadId = null;
    const detail = { orphanedIds: newlyOrphanedIds };
    window.dispatchEvent(new CustomEvent('da-comments-orphaned', { detail }));
  }
}

function scheduleReResolve() {
  if (reResolveTimer) clearTimeout(reResolveTimer);
  reResolveTimer = setTimeout(() => {
    reResolveTimer = null;
    const { view } = window;
    if (!view) return;
    const { state } = view;

    positionCache.forEach((range, threadId) => {
      if (range.from < range.to) return;
      const root = commentService.getRootComment(threadId);
      if (!root?.selectedText) return;

      if (range.from > range.to) {
        const match = anchorComment(state, root);
        if (match) positionCache.set(threadId, match);
      } else {
        try {
          const end = range.from + root.selectedText.length;
          if (end <= state.doc.content.size) {
            const text = state.doc.textBetween(range.from, end, '', '');
            if (text === root.selectedText) {
              positionCache.set(threadId, { from: range.from, to: end });
            }
          }
        } catch { /* position out of bounds */ }
      }
    });

    commentService.threads.forEach((thread, threadId) => {
      if (positionCache.has(threadId)) return;
      const root = getRootForThread(thread);
      if (!root || root.resolved) return;
      const match = anchorComment(state, root);
      if (match) positionCache.set(threadId, match);
    });

    positionCache.forEach((_, threadId) => {
      if (!commentService.threads.has(threadId)) positionCache.delete(threadId);
    });

    detectOrphans(positionCache);
    const decos = buildDecorations(state, positionCache);
    view.dispatch(state.tr.setMeta(commentPluginKey, { decos }));
  }, 300);
}

function scheduleAnchorUpdate() {
  if (anchorUpdateTimer) clearTimeout(anchorUpdateTimer);
  anchorUpdateTimer = setTimeout(() => {
    anchorUpdateTimer = null;
    const { view } = window;
    if (!view) return;
    updateCommentAnchors(view.state, positionCache);
  }, 150);
}

function dispatchSelectionChange() {
  window.dispatchEvent(new Event('da-selection-change'));
}

export function hasValidCommentSelection(state) {
  if (!state) return false;
  const { selection } = state;

  if (selection instanceof NodeSelection) {
    const nodeName = selection.node?.type.name;
    if (nodeName === 'image') return true;
    if (nodeName === 'table') return hasSelectableTableContent(selection.node);
    return false;
  }

  if (selection instanceof CellSelection) {
    let hasContent = false;
    selection.forEachCell((cell) => {
      if (hasSelectableTableContent(cell)) hasContent = true;
    });
    return hasContent;
  }

  const { from, to } = selection;
  if (from === to) return false;
  const selectedText = state.doc.textBetween(from, to, '', '');
  return selectedText.trim().length > 0;
}

export function openCommentPanel() {
  if (!window.view) return false;
  const { state } = window.view;
  if (!hasValidCommentSelection(state)) return false;
  window.dispatchEvent(new CustomEvent('da-comment-add'));
  return true;
}

function rebuildDecorations() {
  const { view } = window;
  if (!view) return;
  const decos = buildDecorations(view.state, positionCache);
  view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
}

export function setActiveThread(threadId) {
  if (activeThreadId === threadId) return;
  activeThreadId = threadId ?? null;
  rebuildDecorations();
}

export function setPendingRange(from, to) {
  if (from != null && to != null && from < to) {
    pendingRange = { from, to };
  } else {
    pendingRange = null;
  }
  rebuildDecorations();
}

export function clearPendingRange() {
  if (!pendingRange) return;
  pendingRange = null;
  rebuildDecorations();
}

function handleClick(view, pos) {
  let threadId = null;
  let bestSize = Infinity;
  positionCache.forEach((range, id) => {
    if (range.from < range.to && pos >= range.from && pos <= range.to) {
      const size = range.to - range.from;
      if (size < bestSize) {
        bestSize = size;
        threadId = id;
      }
    }
  });

  if (threadId) {
    activeThreadId = threadId;
    const decos = buildDecorations(view.state, positionCache);
    view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
    window.dispatchEvent(new CustomEvent('da-comment-highlight-click', { detail: { threadId } }));
    return true;
  }

  if (activeThreadId) {
    activeThreadId = null;
    const decos = buildDecorations(view.state, positionCache);
    view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
    window.dispatchEvent(new CustomEvent('da-comment-highlight-click', { detail: { threadId: null } }));
  }
  return false;
}

let lastSelectionKey = '';
let serviceListenerAttached = false;

export function createCommentPlugin() {
  return new Plugin({
    key: commentPluginKey,

    state: {
      init(_, state) {
        positionCache = new Map();
        return buildDecorations(state, positionCache);
      },

      apply(tr, oldDecos, _oldState, newState) {
        const forcedDecos = tr.getMeta(commentPluginKey);
        if (forcedDecos?.decos) return forcedDecos.decos;

        if (tr.docChanged) {
          positionCache = mapPositionCache(positionCache, tr.mapping);
          return buildDecorations(newState, positionCache);
        }

        return oldDecos;
      },
    },

    view() {
      if (!serviceListenerAttached) {
        commentService.addEventListener('change', () => scheduleReResolve());
        serviceListenerAttached = true;
      }

      scheduleReResolve();

      return {
        update(view, prevState) {
          if (view.state.doc !== prevState.doc) {
            scheduleReResolve();
            scheduleAnchorUpdate();
          }

          const { from, to } = view.state.selection;
          const { from: prevFrom, to: prevTo } = prevState.selection;
          const selectionKey = `${from}-${to}`;
          const prevSelectionKey = `${prevFrom}-${prevTo}`;

          if (selectionKey !== prevSelectionKey && selectionKey !== lastSelectionKey) {
            lastSelectionKey = selectionKey;
            dispatchSelectionChange();
          }
        },
        destroy() {
          if (reResolveTimer) clearTimeout(reResolveTimer);
          if (anchorUpdateTimer) clearTimeout(anchorUpdateTimer);
        },
      };
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleClick(view, pos) {
        return handleClick(view, pos);
      },
      handleDOMEvents: {
        mouseover(view, event) {
          const span = event.target.closest('.da-comment-highlight');
          const tid = span?.getAttribute('data-comment-thread') || null;
          if (tid === hoverThreadId) return false;
          hoverThreadId = tid;
          const decos = buildDecorations(view.state, positionCache);
          view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
          return false;
        },
        mouseout(view, event) {
          if (!hoverThreadId) return false;
          if (event.relatedTarget && view.dom.contains(event.relatedTarget)) return false;
          hoverThreadId = null;
          const decos = buildDecorations(view.state, positionCache);
          view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
          return false;
        },
      },
    },
  });
}
