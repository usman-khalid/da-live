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
import commentService from '../../../da-comments/helpers/index.js';
import {
  findThreadAtPosition,
  mapPositionCache,
  rebuildPositionCache,
  syncOrphanedThreads,
} from './helpers/index.js';

const commentPluginKey = new PluginKey('comments');

let pluginController = null;

function setPluginController(controller) {
  pluginController = controller;
}

function clearPluginController(controller) {
  if (pluginController === controller) {
    pluginController = null;
  }
}

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

function buildDecorations(state, pluginState) {
  const decorations = [];
  const {
    positionCache,
    activeThreadId,
    hoverThreadId,
    pendingRange,
  } = pluginState;

  positionCache.forEach((range, threadId) => {
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

function rebuildDecorations(view, pluginState) {
  if (!view) return;
  const decos = buildDecorations(view.state, pluginState);
  view.dispatch(view.state.tr.setMeta(commentPluginKey, { decos }));
}

async function detectOrphans(pluginState) {
  const newlyOrphanedIds = await syncOrphanedThreads(commentService, pluginState.positionCache);
  if (newlyOrphanedIds.length > 0) {
    if (newlyOrphanedIds.includes(pluginState.activeThreadId)) {
      pluginState.activeThreadId = null;
    }
    const detail = { orphanedIds: newlyOrphanedIds };
    window.dispatchEvent(new CustomEvent('da-comments-orphaned', { detail }));
  }
}

function scheduleReResolve(view, pluginState) {
  if (pluginState.reResolveTimer) clearTimeout(pluginState.reResolveTimer);
  pluginState.reResolveTimer = setTimeout(async () => {
    pluginState.reResolveTimer = null;
    if (!view) return;

    pluginState.positionCache = rebuildPositionCache(
      view.state,
      commentService.threads,
      pluginState.positionCache,
    );

    await detectOrphans(pluginState);
    rebuildDecorations(view, pluginState);
  }, 300);
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

export function setActiveThread(threadId) {
  pluginController?.setActiveThread(threadId ?? null);
}

export function setPendingRange(from, to) {
  pluginController?.setPendingRange(from, to);
}

export function clearPendingRange() {
  pluginController?.clearPendingRange();
}

function handleClick(view, pos, pluginState) {
  const threadId = findThreadAtPosition(pluginState.positionCache, pos);
  if (threadId) {
    pluginState.activeThreadId = threadId;
    rebuildDecorations(view, pluginState);
    window.dispatchEvent(new CustomEvent('da-comment-highlight-click', { detail: { threadId } }));
    return true;
  }

  if (pluginState.activeThreadId) {
    pluginState.activeThreadId = null;
    rebuildDecorations(view, pluginState);
    window.dispatchEvent(new CustomEvent('da-comment-highlight-click', { detail: { threadId: null } }));
  }
  return false;
}

export function createCommentPlugin() {
  const pluginState = {
    positionCache: new Map(),
    reResolveTimer: null,
    activeThreadId: null,
    hoverThreadId: null,
    pendingRange: null,
    lastSelectionKey: '',
    serviceChangeHandler: null,
  };

  return new Plugin({
    key: commentPluginKey,

    state: {
      init(_, state) {
        pluginState.positionCache = new Map();
        return buildDecorations(state, pluginState);
      },

      apply(tr, oldDecos, _oldState, newState) {
        const forcedDecos = tr.getMeta(commentPluginKey);
        if (forcedDecos?.decos) return forcedDecos.decos;

        if (tr.docChanged) {
          pluginState.positionCache = mapPositionCache(pluginState.positionCache, tr.mapping);
          return buildDecorations(newState, pluginState);
        }

        return oldDecos;
      },
    },

    view(view) {
      const controller = {
        setActiveThread(threadId) {
          if (pluginState.activeThreadId === threadId) return;
          pluginState.activeThreadId = threadId;
          rebuildDecorations(view, pluginState);
        },
        setPendingRange(from, to) {
          if (from != null && to != null && from < to) {
            pluginState.pendingRange = { from, to };
          } else {
            pluginState.pendingRange = null;
          }
          rebuildDecorations(view, pluginState);
        },
        clearPendingRange() {
          if (!pluginState.pendingRange) return;
          pluginState.pendingRange = null;
          rebuildDecorations(view, pluginState);
        },
      };
      setPluginController(controller);
      pluginState.serviceChangeHandler = () => scheduleReResolve(view, pluginState);
      commentService.addEventListener('change', pluginState.serviceChangeHandler);
      scheduleReResolve(view, pluginState);

      return {
        update(editorView, prevState) {
          if (editorView.state.doc !== prevState.doc) {
            scheduleReResolve(editorView, pluginState);
          }

          const { from, to } = editorView.state.selection;
          const { from: prevFrom, to: prevTo } = prevState.selection;
          const selectionKey = `${from}-${to}`;
          const prevSelectionKey = `${prevFrom}-${prevTo}`;

          if (selectionKey !== prevSelectionKey && selectionKey !== pluginState.lastSelectionKey) {
            pluginState.lastSelectionKey = selectionKey;
            dispatchSelectionChange();
          }
        },
        destroy() {
          if (pluginState.reResolveTimer) clearTimeout(pluginState.reResolveTimer);
          if (pluginState.serviceChangeHandler) {
            commentService.removeEventListener('change', pluginState.serviceChangeHandler);
            pluginState.serviceChangeHandler = null;
          }
          clearPluginController(controller);
        },
      };
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleClick(view, pos) {
        return handleClick(view, pos, pluginState);
      },
      handleDOMEvents: {
        mouseover(view, event) {
          const span = event.target.closest('.da-comment-highlight');
          const tid = span?.getAttribute('data-comment-thread') || null;
          if (tid === pluginState.hoverThreadId) return false;
          pluginState.hoverThreadId = tid;
          rebuildDecorations(view, pluginState);
          return false;
        },
        mouseout(view, event) {
          if (!pluginState.hoverThreadId) return false;
          if (event.relatedTarget && view.dom.contains(event.relatedTarget)) return false;
          pluginState.hoverThreadId = null;
          rebuildDecorations(view, pluginState);
          return false;
        },
      },
    },
  });
}
