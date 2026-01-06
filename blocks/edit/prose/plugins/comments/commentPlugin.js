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
let fingerprintTimer = null;
let activeThreadId = null;
let hoverThreadId = null;
let pendingRange = null;

function findImagePosition(state, comment) {
  let found = null;
  state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.type.name === 'image') {
      const src = node.attrs?.src || '';
      if (comment.imageRef && src.includes(comment.imageRef)) {
        found = pos;
        return false;
      }
    }
    return true;
  });
  return found;
}

function getRootForThread(thread) {
  return thread.find((c) => c.parentId === null) || thread[0];
}

function anchorComment(state, root) {
  if (root.isImage) {
    const imgPos = findImagePosition(state, root);
    return imgPos != null ? { from: imgPos, to: imgPos + 1 } : null;
  }
  if (!root.selectedText) return null;

  if (root.anchorFrom != null && root.anchorTo != null) {
    try {
      const { anchorFrom, anchorTo } = root;
      if (anchorFrom >= 0 && anchorTo <= state.doc.content.size && anchorFrom < anchorTo) {
        const text = state.doc.textBetween(anchorFrom, anchorTo, '', '');
        if (text === root.selectedText) return { from: anchorFrom, to: anchorTo };
      }
    } catch { /* stored positions out of bounds */ }
  }

  return findBestMatchPosition(state, root.selectedText, root.positionContext);
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

    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: cls,
        'data-comment-thread': threadId,
      }),
    );
  });

  if (pendingRange && pendingRange.from < pendingRange.to) {
    const attrs = { class: 'da-comment-highlight-pending' };
    decorations.push(Decoration.inline(pendingRange.from, pendingRange.to, attrs));
  }

  return DecorationSet.create(state.doc, decorations);
}

function updateCommentFingerprints(state, cache) {
  if (!commentService.initialized || commentService.readOnly) return;

  cache.forEach((range, threadId) => {
    if (range.from >= range.to) return;
    const root = commentService.getRootComment(threadId);
    if (!root || root.isImage) return;

    const currentText = state.doc.textBetween(range.from, range.to, '', '');
    if (!currentText || currentText === root.selectedText) return;
    if (root.selectedText.includes(currentText)) return;

    const newContext = getPositionContext(state, range.from, range.to);
    commentService.save({
      ...root,
      selectedText: currentText,
      positionContext: newContext,
      anchorFrom: range.from,
      anchorTo: range.to,
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

function scheduleFingerprintUpdate() {
  if (fingerprintTimer) clearTimeout(fingerprintTimer);
  fingerprintTimer = setTimeout(() => {
    fingerprintTimer = null;
    const { view } = window;
    if (!view) return;
    updateCommentFingerprints(view.state, positionCache);
  }, 5000);
}

function dispatchSelectionChange() {
  window.dispatchEvent(new Event('da-selection-change'));
}

export function hasValidCommentSelection(state) {
  if (!state) return false;
  const { selection } = state;

  if (selection instanceof NodeSelection) {
    return selection.node?.type.name === 'image';
  }

  if (selection instanceof CellSelection) {
    let hasContent = false;
    selection.forEachCell((cell) => {
      if (cell.textContent.trim()) hasContent = true;
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
            scheduleFingerprintUpdate();
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
          if (fingerprintTimer) clearTimeout(fingerprintTimer);
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
