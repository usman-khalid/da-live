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
  Slice,
  CellSelection,
} from 'da-y-wrapper';
import { groupCommentsByThread, findBestMatchPosition, getPositionContext } from '../../../da-comments/helpers/comment-utils.js';

const ADD_WIDGET_DELAY_MS = 300;
const SYNC_STABILITY_DELAY_MS = 500;

const commentPluginKey = new PluginKey('comments');

const pluginState = {
  commentsMap: null,
  activeThreadId: null,
  pendingCommentRange: null,
  initialSyncComplete: false,
  addWidgetTimeout: null,
  showAddWidget: false,
  syncStabilityTimeout: null,
  lastDocChangeTime: 0,
};

/**
 * Get all thread IDs that have marks in the document.
 * @param {object} state - ProseMirror state
 * @returns {Set<string>} Set of thread IDs with marks or image comments
 */
function getThreadIdsWithMarks(state) {
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return new Set();

  const threadIds = new Set();
  const { doc } = state;

  doc.descendants((node) => {
    if (node.marks && node.marks.length > 0) {
      node.marks.forEach((mark) => {
        if (mark.type === commentMark) {
          threadIds.add(mark.attrs.threadId);
        }
      });
    }
    if (node.type.name === 'image' && node.attrs.commentThreadId) {
      threadIds.add(node.attrs.commentThreadId);
    }
  });

  return threadIds;
}

/**
 * Find the root comment entry for a specific thread.
 * @param {string} threadId - Thread ID to find
 * @returns {object|null} { id, comment } or null if not found
 */
function findRootCommentEntry(threadId) {
  if (!pluginState.commentsMap) return null;

  let result = null;
  pluginState.commentsMap.forEach((comment, id) => {
    if (comment.threadId === threadId && comment.parentId === null) {
      result = { id, comment };
    }
  });
  return result;
}

/**
 * Set the Yjs comments map for the plugin
 * @param {Y.Map} map - Yjs Map containing comments
 */
export function setCommentsMap(map) {
  pluginState.commentsMap = map;
  pluginState.initialSyncComplete = false;
}

/**
 * Recover missing marks for comments that exist but don't have marks.
 * This handles the case where comments synced but the document didn't.
 * Uses position context for accurate recovery when text appears multiple times.
 */
function recoverMissingMarks() {
  if (!window.view || !pluginState.commentsMap) return;

  const { state } = window.view;
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return;

  const threadIdsWithMarks = getThreadIdsWithMarks(state);
  const threads = groupCommentsByThread(pluginState.commentsMap);

  let hasRecoveries = false;
  let { tr } = state;

  for (const [threadId, comments] of threads.entries()) {
    if (threadIdsWithMarks.has(threadId)) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const rootComment = comments.find((c) => c.parentId === null);
    if (!rootComment || rootComment.resolved) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const { selectedText, positionContext } = rootComment;
    if (!selectedText || selectedText.trim().length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const match = findBestMatchPosition(state, selectedText, positionContext);
    if (match) {
      tr = tr.addMark(match.from, match.to, commentMark.create({ threadId }));
      hasRecoveries = true;
    }
  }

  if (hasRecoveries && tr.steps.length > 0) {
    window.view.dispatch(tr);
  }
}

/**
 * Marks sync as complete and runs mark recovery.
 */
function onSyncStable() {
  if (pluginState.initialSyncComplete) return;
  pluginState.initialSyncComplete = true;
  recoverMissingMarks();
}

/**
 * Reset the stability timer. Called when document changes occur.
 * This ensures we wait for the document to be stable before running recovery.
 */
function resetSyncStabilityTimer() {
  pluginState.lastDocChangeTime = Date.now();

  if (pluginState.syncStabilityTimeout) {
    clearTimeout(pluginState.syncStabilityTimeout);
    pluginState.syncStabilityTimeout = null;
  }
}

/**
 * Start waiting for document stability after initial sync.
 * Uses awareness of document changes rather than a fixed delay.
 */
function waitForDocumentStability() {
  if (pluginState.syncStabilityTimeout) {
    clearTimeout(pluginState.syncStabilityTimeout);
  }

  const checkStability = () => {
    const timeSinceLastChange = Date.now() - pluginState.lastDocChangeTime;

    if (timeSinceLastChange >= SYNC_STABILITY_DELAY_MS) {
      onSyncStable();
    } else {
      const remainingTime = SYNC_STABILITY_DELAY_MS - timeSinceLastChange;
      pluginState.syncStabilityTimeout = setTimeout(checkStability, remainingTime + 50);
    }
  };

  pluginState.syncStabilityTimeout = setTimeout(checkStability, SYNC_STABILITY_DELAY_MS);
}

/**
 * Set the WebSocket provider for sync status tracking.
 * Uses document stability detection rather than a fixed delay.
 * @param {WebsocketProvider} provider - The Yjs WebSocket provider
 */
export function setWsProvider(provider) {
  const handleSyncComplete = () => {
    pluginState.lastDocChangeTime = Date.now();
    waitForDocumentStability();
  };

  if (provider.synced) {
    handleSyncComplete();
  } else {
    const handleSynced = (isSynced) => {
      if (isSynced) {
        handleSyncComplete();
        provider.off('synced', handleSynced);
      }
    };
    provider.on('synced', handleSynced);
  }
}

/**
 * Set the currently active/selected thread
 * @param {string|null} threadId
 */
export function setActiveThread(threadId) {
  const previousThreadId = pluginState.activeThreadId;
  pluginState.activeThreadId = threadId;

  if (window.view) {
    const { tr } = window.view.state;
    window.view.dispatch(tr.setMeta(commentPluginKey, { activeThreadId: threadId }));
  }

  if (previousThreadId !== threadId) {
    const detail = { threadId, previousThreadId };
    window.dispatchEvent(new CustomEvent('da-comment-active-changed', { detail }));
  }
}

/**
 * Set a pending comment range (shows temporary highlight while adding a comment)
 * @param {object|null} range - { from, to } or null to clear
 */
export function setPendingCommentRange(range) {
  pluginState.pendingCommentRange = range;

  if (window.view) {
    const { tr } = window.view.state;
    window.view.dispatch(tr.setMeta(commentPluginKey, { pendingCommentRange: range }));
  }
}

/**
 * Clear the pending comment range and collapse the selection
 */
export function clearPendingCommentRange() {
  pluginState.showAddWidget = false;

  if (pluginState.addWidgetTimeout) {
    clearTimeout(pluginState.addWidgetTimeout);
    pluginState.addWidgetTimeout = null;
  }

  setPendingCommentRange(null);
  window.view?.focus?.();
}

/**
 * Check if text is only whitespace (including nbsp)
 * @param {string} text - Text to check
 * @returns {boolean} True if only whitespace
 */
function isOnlyWhitespace(text) {
  return !text || /^[\s\u00A0]*$/.test(text);
}

/**
 * Check if the selection is an image node.
 * @param {object} state - ProseMirror state
 * @returns {boolean}
 */
export function isImageSelection(state) {
  if (!state) return false;
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return false;
  return selection.node?.type.name === 'image';
}

/**
 * Apply comment to an image by setting its commentThreadId attribute.
 * Uses the pending comment range to find the image position.
 * @param {string} threadId - The ID of the comment thread
 * @returns {boolean} True if applied successfully
 */
function applyCommentToImage(threadId) {
  if (!window.view) return false;

  const { state, dispatch } = window.view;

  const pendingRange = pluginState.pendingCommentRange;
  if (pendingRange?.isImage) {
    const node = state.doc.nodeAt(pendingRange.from);
    if (node?.type.name === 'image') {
      const tr = state.tr.setNodeMarkup(pendingRange.from, null, {
        ...node.attrs,
        commentThreadId: threadId,
      });
      dispatch(tr);
      return true;
    }
  }

  const { selection } = state;
  if (!(selection instanceof NodeSelection)) {
    return false;
  }
  if (selection.node?.type.name !== 'image') {
    return false;
  }

  const pos = selection.from;
  const tr = state.tr.setNodeMarkup(pos, null, {
    ...selection.node.attrs,
    commentThreadId: threadId,
  });
  dispatch(tr);
  return true;
}

/**
 * Apply the comment mark to the current selection or to text found by matching.
 * Handles regular text selection, image selection, and table cell selection.
 *
 * @param {string} threadId - The ID of the comment thread
 * @param {Object} options - Optional parameters for text-based matching
 * @param {string} options.selectedText - Text to find and mark (for collaborative safety)
 * @param {Object} options.positionContext - Position context for disambiguation
 * @param {boolean} options.isImage - Whether this is an image comment
 * @returns {boolean} True if mark was applied successfully
 */
export function applyCommentMark(threadId, options = {}) {
  if (!window.view) return false;

  const { state, dispatch } = window.view;

  if (options.isImage || isImageSelection(state)) {
    return applyCommentToImage(threadId);
  }

  const commentMark = state.schema.marks.comment;
  if (!commentMark) {
    // eslint-disable-next-line no-console
    console.error('Comment mark not found in schema');
    return false;
  }

  let { tr } = state;
  const { selection } = state;

  if (selection instanceof CellSelection) {
    selection.forEachCell((cell, pos) => {
      const cellStart = pos + 1;
      const cellEnd = pos + cell.nodeSize - 1;
      if (cellEnd > cellStart) {
        tr = tr.addMark(cellStart, cellEnd, commentMark.create({ threadId }));
      }
      cell.descendants((node, nodePos) => {
        if (node.type.name === 'image') {
          const absolutePos = pos + 1 + nodePos;
          tr = tr.setNodeMarkup(absolutePos, null, {
            ...node.attrs,
            commentThreadId: threadId,
          });
        }
      });
    });
  } else if (options.selectedText) {
    const match = findBestMatchPosition(state, options.selectedText, options.positionContext);
    if (!match) return false;
    tr = tr.addMark(match.from, match.to, commentMark.create({ threadId }));
  } else {
    const { from, to } = selection;
    if (from === to) return false;

    const selectedText = state.doc.textBetween(from, to, '', '');
    if (isOnlyWhitespace(selectedText)) return false;

    tr = tr.addMark(from, to, commentMark.create({ threadId }));
  }

  if (tr.steps.length === 0) return false;

  dispatch(tr);
  return true;
}

/**
 * Remove the comment mark for a specific thread.
 * Handles both text marks and image node attributes.
 *
 * @param {string} threadId - The ID of the comment thread to remove
 */
export function removeCommentMark(threadId) {
  if (!window.view) return;

  const { state, dispatch } = window.view;
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return;

  const { doc, tr: baseTr } = state;
  let tr = baseTr;
  let found = false;

  doc.descendants((node, pos) => {
    if (node.isText) {
      const marks = node.marks.filter(
        (m) => m.type === commentMark && m.attrs.threadId === threadId,
      );
      if (marks.length > 0) {
        tr = tr.removeMark(pos, pos + node.nodeSize, commentMark.create({ threadId }));
        found = true;
      }
    }
    if (node.type.name === 'image' && node.attrs.commentThreadId === threadId) {
      tr = tr.setNodeMarkup(pos, null, {
        ...node.attrs,
        commentThreadId: null,
      });
      found = true;
    }
  });

  if (found) {
    dispatch(tr);
  }
}

/**
 * Find the position range of a comment mark or image by thread ID.
 * Used for scrolling to comments and highlighting active comment.
 *
 * @param {object} state - ProseMirror state
 * @param {string} threadId - Thread ID to find
 * @returns {object|null} { from, to, isImage } or null if not found
 */
function findCommentMarkRange(state, threadId) {
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return null;

  let result = null;
  const { doc } = state;

  doc.descendants((node, pos) => {
    if (result) return false;

    if (node.type.name === 'image' && node.attrs.commentThreadId === threadId) {
      result = { from: pos, to: pos + node.nodeSize, isImage: true };
      return false;
    }

    if (node.isText) {
      const mark = node.marks.find(
        (m) => m.type === commentMark && m.attrs.threadId === threadId,
      );
      if (mark) {
        let from = pos;
        let to = pos + node.nodeSize;

        const $pos = doc.resolve(pos);
        const { parent, parentOffset } = $pos;

        let offset = parentOffset;
        while (offset > 0) {
          const prevNode = parent.child(parent.childBefore(offset).index);
          if (!prevNode.isText) break;
          const prevMark = prevNode.marks.find(
            (m) => m.type === commentMark && m.attrs.threadId === threadId,
          );
          if (!prevMark) break;
          offset -= prevNode.nodeSize;
          from = pos - (parentOffset - offset);
        }

        doc.nodesBetween(pos, doc.content.size, (n, p) => {
          if (p < pos) return true;
          if (!n.isText) return true;
          const m = n.marks.find(
            (mark2) => mark2.type === commentMark && mark2.attrs.threadId === threadId,
          );
          if (m) {
            to = p + n.nodeSize;
            return true;
          }
          return false;
        });

        result = { from, to, isImage: false };
        return false;
      }
    }
    return true;
  });

  return result;
}

/**
 * Restore orphaned comments when their marks reappear (e.g., via redo).
 * This handles the case where user undoes a comment (orphaning it) then redoes.
 *
 * @param {Set} threadIdsWithMarks - Pre-computed set of thread IDs with marks
 * @param {Map} threads - Pre-computed thread groupings
 */
function restoreOrphanedComments(threadIdsWithMarks, threads) {
  if (!pluginState.commentsMap) return;
  if (!pluginState.initialSyncComplete) return;

  const restoredIds = [];
  for (const [threadId, comments] of threads.entries()) {
    const rootComment = comments.find((c) => c.parentId === null);
    const isOrphaned = rootComment?.orphaned;

    if (isOrphaned && threadIdsWithMarks.has(threadId)) {
      restoredIds.push(threadId);
    }
  }

  if (restoredIds.length > 0) {
    pluginState.commentsMap.forEach((comment, id) => {
      if (restoredIds.includes(comment.threadId) && comment.parentId === null) {
        pluginState.commentsMap.set(id, {
          ...comment,
          orphaned: false,
          orphanedAt: null,
        });
      }
    });
  }
}

/**
 * Check for orphaned comments (comments without corresponding marks).
 * This happens when all the commented text is deleted.
 * Instead of deleting, mark comments as orphaned (detached) so the conversation is preserved.
 *
 * @param {object} state - ProseMirror state
 * @param {Set} threadIdsWithMarks - Pre-computed set of thread IDs with marks
 * @param {Map} threads - Pre-computed thread groupings
 */
function markOrphanedComments(state, threadIdsWithMarks, threads) {
  if (!pluginState.commentsMap) return;
  if (!pluginState.initialSyncComplete) {
    return;
  }

  const newlyOrphanedIds = [];
  for (const [threadId, comments] of threads.entries()) {
    const rootComment = comments.find((c) => c.parentId === null);
    const isResolved = rootComment?.resolved;
    const isAlreadyOrphaned = rootComment?.orphaned;

    if (!threadIdsWithMarks.has(threadId) && !isResolved && !isAlreadyOrphaned) {
      newlyOrphanedIds.push(threadId);
    }
  }

  if (newlyOrphanedIds.length > 0) {
    pluginState.commentsMap.forEach((comment, id) => {
      if (newlyOrphanedIds.includes(comment.threadId) && comment.parentId === null) {
        pluginState.commentsMap.set(id, {
          ...comment,
          orphaned: true,
          orphanedAt: Date.now(),
        });
      }
    });

    if (newlyOrphanedIds.includes(pluginState.activeThreadId)) {
      pluginState.activeThreadId = null;
    }

    if (window.view) {
      const viewState = window.view.state;
      const commentMark = viewState.schema.marks.comment;
      if (commentMark && viewState.storedMarks) {
        const hasOrphanedMark = viewState.storedMarks.some(
          (m) => m.type === commentMark && newlyOrphanedIds.includes(m.attrs.threadId),
        );
        if (hasOrphanedMark) {
          const cleanMarks = viewState.storedMarks.filter(
            (m) => m.type !== commentMark || !newlyOrphanedIds.includes(m.attrs.threadId),
          );
          const tr = viewState.tr.setStoredMarks(cleanMarks.length > 0 ? cleanMarks : null);
          window.view.dispatch(tr);
        }
      }
    }

    const detail = { orphanedIds: newlyOrphanedIds };
    window.dispatchEvent(new CustomEvent('da-comments-orphaned', { detail }));
  }
}

/**
 * Update the selectedText in comments when the marked content changes.
 * This keeps the comment metadata in sync with the actual highlighted text.
 *
 * @param {object} state - ProseMirror state
 * @param {Set} threadIdsWithMarks - Pre-computed set of thread IDs with marks
 */
function updateCommentSelectedText(state, threadIdsWithMarks) {
  if (!pluginState.commentsMap) return;

  const commentMark = state.schema.marks.comment;
  if (!commentMark) return;

  for (const threadId of threadIdsWithMarks) {
    const range = findCommentMarkRange(state, threadId);
    if (range) {
      let currentText;
      let currentContext = null;
      if (range.isImage) {
        const node = state.doc.nodeAt(range.from);
        currentText = node?.attrs?.alt || '[Image]';
      } else {
        currentText = state.doc.textBetween(range.from, range.to, '\n', '');
        currentContext = getPositionContext(state, range.from, range.to);
      }

      const entry = findRootCommentEntry(threadId);
      if (entry && entry.comment.selectedText !== currentText) {
        const updates = { ...entry.comment, selectedText: currentText };
        if (currentContext) {
          updates.positionContext = currentContext;
        }
        pluginState.commentsMap.set(entry.id, updates);
      }
    }
  }
}

/**
 * Check if the current selection is valid for adding a comment.
 * Must be a non-empty text selection, image selection, or table cell selection.
 *
 * @param {object} state - ProseMirror state
 * @returns {boolean}
 */
export function hasValidCommentSelection(state) {
  if (!state) return false;

  if (isImageSelection(state)) return true;

  if (state.selection instanceof CellSelection) {
    let hasContent = false;
    state.selection.forEachCell((cell) => {
      if (cell.textContent.trim()) hasContent = true;
    });
    return hasContent;
  }

  const { from, to } = state.selection;
  if (from === to) return false;

  const selectedText = state.doc.textBetween(from, to, '', '');
  return !isOnlyWhitespace(selectedText);
}

/**
 * Create the inline "+" button widget for adding comments.
 * @returns {HTMLElement}
 */
function createAddCommentWidget() {
  const button = document.createElement('button');
  button.className = 'da-add-comment-widget';
  button.setAttribute('title', 'Add comment');
  button.setAttribute('type', 'button');
  button.textContent = '+';
  button.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('da-comment-add'));
  });
  return button;
}

/**
 * Build decorations for comment highlights.
 * - Text comments: base highlight comes from marks, decorations add active state
 * - Image comments: ALL highlighting via decorations (more reliable than toDOM)
 * - Add comment widget: shows "+" button at selection end
 *
 * @param {object} state - ProseMirror state
 * @returns {DecorationSet}
 */
function buildDecorations(state) {
  const decorations = [];

  const threadIdsWithMarks = getThreadIdsWithMarks(state);
  const threads = pluginState.commentsMap
    ? groupCommentsByThread(pluginState.commentsMap)
    : new Map();

  restoreOrphanedComments(threadIdsWithMarks, threads);
  markOrphanedComments(state, threadIdsWithMarks, threads);
  updateCommentSelectedText(state, threadIdsWithMarks);

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.commentThreadId) {
      const { commentThreadId } = node.attrs;
      const isActive = commentThreadId === pluginState.activeThreadId;
      const highlightClass = isActive
        ? 'da-comment-highlight da-comment-highlight-active'
        : 'da-comment-highlight';
      decorations.push(Decoration.node(pos, pos + node.nodeSize, {
        class: highlightClass,
        'data-comment-thread': commentThreadId,
      }));
    }
  });

  if (pluginState.activeThreadId) {
    const range = findCommentMarkRange(state, pluginState.activeThreadId);
    if (range && !range.isImage) {
      const attrs = { class: 'da-comment-highlight-active' };
      decorations.push(Decoration.inline(range.from, range.to, attrs));
    }
  }

  if (pluginState.pendingCommentRange) {
    const { from, to, isImage } = pluginState.pendingCommentRange;
    if (from < to && to <= state.doc.content.size) {
      const attrs = { class: 'da-comment-highlight-pending' };
      if (isImage) {
        decorations.push(Decoration.node(from, to, attrs));
      } else {
        decorations.push(Decoration.inline(from, to, attrs));
      }
    }
  }

  const isCellSel = state.selection instanceof CellSelection;
  const { pendingCommentRange, activeThreadId, showAddWidget } = pluginState;
  const showWidget = !pendingCommentRange && !activeThreadId && showAddWidget && !isCellSel;
  if (showWidget && hasValidCommentSelection(state)) {
    const { from, to } = state.selection;
    const commentMark = state.schema.marks.comment;
    let hasExistingComment = false;

    if (commentMark) {
      state.doc.nodesBetween(from, to, (node) => {
        if (node.marks?.some((m) => m.type === commentMark)) {
          hasExistingComment = true;
          return false;
        }
        return true;
      });
    }

    if (!hasExistingComment) {
      decorations.push(Decoration.widget(to, createAddCommentWidget, { side: 1 }));
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

/**
 * Open the comment panel and start adding a comment.
 *
 * @returns {boolean} True if handled
 */
export function openCommentPanel() {
  if (!window.view) return false;

  const { state } = window.view;

  if (!hasValidCommentSelection(state)) {
    return false;
  }

  // Dispatch event to open comment panel
  window.dispatchEvent(new CustomEvent('da-comment-add'));

  return true;
}

/**
 * Handle clicks on comment highlights (text marks or images).
 * Activates the clicked thread, or clears active thread if clicking elsewhere.
 */
function handleClick(view, pos, event) {
  const { state } = view;
  const commentMark = state.schema.marks.comment;

  // Check DOM element first - most reliable for images
  // (position resolution for inline nodes can be unreliable at edges)
  const clickedElement = event?.target;
  if (clickedElement?.tagName === 'IMG' && clickedElement.dataset.commentThread) {
    const threadId = clickedElement.dataset.commentThread;
    setActiveThread(threadId);
    window.dispatchEvent(new CustomEvent('da-comment-clicked', { detail: { threadId } }));
    return true;
  }

  // Also check the wrapper span (for images in tables)
  const wrapper = clickedElement?.closest('.focal-point-image-wrapper[data-comment-thread]');
  if (wrapper) {
    const threadId = wrapper.dataset.commentThread;
    setActiveThread(threadId);
    window.dispatchEvent(new CustomEvent('da-comment-clicked', { detail: { threadId } }));
    return true;
  }

  if (!commentMark) {
    if (pluginState.activeThreadId) {
      setActiveThread(null);
    }
    return false;
  }

  const $pos = state.doc.resolve(pos);
  const node = $pos.parent.maybeChild($pos.index());
  const nodeAt = state.doc.nodeAt(pos);

  if (node && node.isText) {
    const mark = node.marks.find((m) => m.type === commentMark);
    if (mark) {
      const { threadId } = mark.attrs;
      setActiveThread(threadId);

      const detail = { threadId };
      window.dispatchEvent(new CustomEvent('da-comment-clicked', { detail }));

      return true;
    }
  }

  // Check for image - use nodeAt as fallback (more reliable for inline nodes)
  const imageNode = (node?.type.name === 'image' ? node : null)
    || (nodeAt?.type.name === 'image' ? nodeAt : null);

  if (imageNode?.attrs.commentThreadId) {
    const { commentThreadId } = imageNode.attrs;
    setActiveThread(commentThreadId);

    const detail = { threadId: commentThreadId };
    window.dispatchEvent(new CustomEvent('da-comment-clicked', { detail }));

    return true;
  }

  if (pluginState.activeThreadId) {
    setActiveThread(null);
  }

  return false;
}

/**
 * Maintain comment marks: add marks for valid comments, REMOVE marks for deleted comments.
 *
 * This handles two cases:
 * 1. Typing inside a comment → add the mark to new text (if thread exists)
 * 2. Typing after comment deletion → REMOVE any ghost marks from new text
 *
 * The second case is critical because ProseMirror's storedMarks mechanism
 * will automatically apply marks to new text even after we delete the comment.
 *
 * @param {Transaction} tr - The transaction
 * @param {EditorState} oldState - State before transaction
 * @param {EditorState} newState - State after transaction
 * @returns {Transaction|null} New transaction with mark fixes, or null
 */
function maintainCommentMarks(tr, oldState, newState) {
  if (!tr.docChanged) return null;

  const commentMark = newState.schema.marks.comment;
  if (!commentMark) return null;

  const validThreadIds = new Set();
  if (pluginState.commentsMap) {
    pluginState.commentsMap.forEach((comment) => {
      if (comment && comment.threadId) {
        validThreadIds.add(comment.threadId);
      }
    });
  }

  let fixTr = null;

  newState.doc.descendants((node, pos) => {
    if (node.marks && node.marks.length > 0) {
      node.marks.forEach((mark) => {
        if (mark.type === commentMark) {
          const { threadId } = mark.attrs;

          if (!threadId || !validThreadIds.has(threadId)) {
            if (!fixTr) {
              fixTr = newState.tr;
            }
            fixTr = fixTr.removeMark(pos, pos + node.nodeSize, mark);
          }
        }
      });
    }
  });

  if (tr.getMeta('paste')) {
    return fixTr;
  }

  tr.steps.forEach((step, i) => {
    const map = tr.mapping.maps[i];

    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (newEnd > newStart) {
        let markToApply = null;

        if (oldStart > 0) {
          oldState.doc.nodesBetween(oldStart - 1, oldStart, (node) => {
            if (node.isText && node.marks && !markToApply) {
              const mark = node.marks.find((m) => m.type === commentMark);
              if (mark && mark.attrs.threadId && validThreadIds.has(mark.attrs.threadId)) {
                markToApply = mark;
              }
            }
          });
        }

        if (!markToApply && oldEnd < oldState.doc.content.size) {
          oldState.doc.nodesBetween(oldEnd, oldEnd + 1, (node) => {
            if (node.isText && node.marks && !markToApply) {
              const mark = node.marks.find((m) => m.type === commentMark);
              if (mark && mark.attrs.threadId && validThreadIds.has(mark.attrs.threadId)) {
                markToApply = mark;
              }
            }
          });
        }

        if (!markToApply && oldStart > 0) {
          const $pos = oldState.doc.resolve(oldStart);
          const posMarks = $pos.marks();
          const mark = posMarks.find((m) => m.type === commentMark);
          if (mark && mark.attrs.threadId && validThreadIds.has(mark.attrs.threadId)) {
            markToApply = mark;
          }
        }

        if (markToApply) {
          if (!fixTr) {
            fixTr = newState.tr;
          }
          fixTr = fixTr.addMark(newStart, newEnd, markToApply);
        }
      }
    });
  });

  return fixTr;
}

/**
 * Dispatch selection change event for UI components to react to.
 * @param {object} state - ProseMirror state
 */
function dispatchSelectionChange(state) {
  const { from, to } = state.selection;
  const hasSelection = from !== to || isImageSelection(state);
  window.dispatchEvent(new CustomEvent('da-selection-change', { detail: { hasSelection } }));
}

/**
 * Recursively strip comment marks and image comment attributes from a fragment.
 * @param {Object} fragment - ProseMirror fragment
 * @param {Object} schema - ProseMirror schema
 * @returns {Object} New fragment with comment marks removed
 */
function stripCommentMarksFromFragment(fragment, schema) {
  const commentMarkType = schema.marks.comment;

  const nodes = [];
  fragment.forEach((node) => {
    if (node.isText) {
      if (commentMarkType) {
        const newMarks = node.marks.filter((m) => m.type !== commentMarkType);
        nodes.push(node.mark(newMarks));
      } else {
        nodes.push(node);
      }
    } else if (node.type.name === 'image' && node.attrs.commentThreadId) {
      const newAttrs = { ...node.attrs, commentThreadId: null };
      nodes.push(node.type.create(newAttrs));
    } else {
      const newContent = stripCommentMarksFromFragment(node.content, schema);
      nodes.push(node.copy(newContent));
    }
  });

  return fragment.constructor.fromArray(nodes);
}

/**
 * Create the comment plugin.
 *
 * @returns {Plugin}
 */
export function createCommentPlugin() {
  let lastSelectionKey = '';

  return new Plugin({
    key: commentPluginKey,

    state: {
      init(_, state) {
        return buildDecorations(state);
      },
      apply(tr, oldDecos, oldState, newState) {
        const selectionChanged = !oldState.selection.eq(newState.selection);
        if (tr.docChanged || tr.getMeta(commentPluginKey) || selectionChanged) {
          return buildDecorations(newState);
        }
        return oldDecos.map(tr.mapping, tr.doc);
      },
    },

    view() {
      return {
        update(view, prevState) {
          const docChanged = view.state.doc !== prevState.doc;
          if (docChanged && !pluginState.initialSyncComplete) {
            resetSyncStabilityTimer();
          }

          const { from, to } = view.state.selection;
          const { from: prevFrom, to: prevTo } = prevState.selection;
          const selectionKey = `${from}-${to}`;
          const prevSelectionKey = `${prevFrom}-${prevTo}`;

          if (selectionKey !== prevSelectionKey && selectionKey !== lastSelectionKey) {
            lastSelectionKey = selectionKey;
            dispatchSelectionChange(view.state);

            if (pluginState.addWidgetTimeout) {
              clearTimeout(pluginState.addWidgetTimeout);
              pluginState.addWidgetTimeout = null;
            }
            pluginState.showAddWidget = false;

            const hasSelection = from !== to;
            if (hasSelection && hasValidCommentSelection(view.state)) {
              pluginState.addWidgetTimeout = setTimeout(() => {
                pluginState.showAddWidget = true;
                pluginState.addWidgetTimeout = null;
                const { tr } = view.state;
                view.dispatch(tr.setMeta(commentPluginKey, { showWidget: true }));
              }, ADD_WIDGET_DELAY_MS);
            }
          }
        },
        destroy() {
          if (pluginState.addWidgetTimeout) {
            clearTimeout(pluginState.addWidgetTimeout);
            pluginState.addWidgetTimeout = null;
          }
          if (pluginState.syncStabilityTimeout) {
            clearTimeout(pluginState.syncStabilityTimeout);
            pluginState.syncStabilityTimeout = null;
          }
        },
      };
    },

    appendTransaction(transactions, oldState, newState) {
      const hasDocChange = transactions.some((tr) => tr.docChanged);
      if (!hasDocChange) return null;

      for (const tr of transactions) {
        const fixTr = maintainCommentMarks(tr, oldState, newState);
        if (fixTr && fixTr.steps.length > 0) {
          return fixTr;
        }
      }

      return null;
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleClick,
      transformPasted(slice, view) {
        const strippedContent = stripCommentMarksFromFragment(slice.content, view.state.schema);
        return new Slice(strippedContent, slice.openStart, slice.openEnd);
      },
    },
  });
}
