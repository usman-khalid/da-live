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
} from 'da-y-wrapper';
import { groupCommentsByThread, findBestMatchPosition, getPositionContext } from '../../../da-comments/helpers/comment-utils.js';

const commentPluginKey = new PluginKey('comments');

let commentsMap = null;
let activeThreadId = null;
let pendingCommentRange = null;
let initialSyncComplete = false;
let addWidgetTimeout = null;
let showAddWidget = false;

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
 * Set the Yjs comments map for the plugin
 * @param {Y.Map} map - Yjs Map containing comments
 */
export function setCommentsMap(map) {
  commentsMap = map;
  initialSyncComplete = false;
}

/**
 * Recover missing marks for comments that exist but don't have marks.
 * This handles the case where comments synced but the document didn't.
 * Uses position context for accurate recovery when text appears multiple times.
 */
function recoverMissingMarks() {
  if (!window.view || !commentsMap) return;

  const { state } = window.view;
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return;

  const threadIdsWithMarks = getThreadIdsWithMarks(state);
  const threads = groupCommentsByThread(commentsMap);

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
    // eslint-disable-next-line no-console
    console.log('Comments: Recovered missing marks for comments');
  }
}

/**
 * Set the WebSocket provider for sync status tracking
 * @param {WebsocketProvider} provider - The Yjs WebSocket provider
 */
export function setWsProvider(provider) {
  const markSyncComplete = () => {
    setTimeout(() => {
      initialSyncComplete = true;
      recoverMissingMarks();
    }, 2000);
  };

  if (provider.synced) {
    markSyncComplete();
  } else {
    const handleSynced = (isSynced) => {
      if (isSynced) {
        markSyncComplete();
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
  const previousThreadId = activeThreadId;
  activeThreadId = threadId;

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
  pendingCommentRange = range;
  if (window.view) {
    const { tr } = window.view.state;
    window.view.dispatch(tr.setMeta(commentPluginKey, { pendingCommentRange: range }));
  }
}

/**
 * Clear the pending comment range and collapse the selection
 */
export function clearPendingCommentRange() {
  showAddWidget = false;

  if (addWidgetTimeout) {
    clearTimeout(addWidgetTimeout);
    addWidgetTimeout = null;
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
 * @param {string} threadId - The ID of the comment thread
 * @returns {boolean} True if applied successfully
 */
export function applyCommentToImage(threadId) {
  if (!window.view) return false;

  const { state, dispatch } = window.view;
  const { selection } = state;

  if (!(selection instanceof NodeSelection)) return false;
  if (selection.node?.type.name !== 'image') return false;

  const pos = selection.from;
  const tr = state.tr.setNodeMarkup(pos, null, {
    ...selection.node.attrs,
    commentThreadId: threadId,
  });
  dispatch(tr);
  return true;
}

/**
 * Apply the comment mark to the current selection.
 *
 * @param {string} threadId - The ID of the comment thread
 * @returns {boolean} True if mark was applied successfully
 */
export function applyCommentMark(threadId) {
  if (!window.view) return false;

  const { state, dispatch } = window.view;

  if (isImageSelection(state)) {
    return applyCommentToImage(threadId);
  }

  const { from, to } = state.selection;

  if (from === to) return false;

  const selectedText = state.doc.textBetween(from, to, '', '');
  if (isOnlyWhitespace(selectedText)) return false;

  const commentMark = state.schema.marks.comment;
  if (!commentMark) {
    // eslint-disable-next-line no-console
    console.error('Comment mark not found in schema');
    return false;
  }

  const tr = state.tr.addMark(from, to, commentMark.create({ threadId }));
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
 * Check for orphaned comments (comments without corresponding marks).
 * This happens when all the commented text is deleted.
 * Instead of deleting, mark comments as orphaned so the conversation is preserved.
 *
 * @param {object} state - ProseMirror state
 */
function markOrphanedComments(state) {
  if (!commentsMap) return;
  if (!initialSyncComplete) {
    return;
  }

  const threadIdsWithMarks = getThreadIdsWithMarks(state);
  const threads = groupCommentsByThread(commentsMap);

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
    commentsMap.forEach((comment, id) => {
      if (newlyOrphanedIds.includes(comment.threadId) && comment.parentId === null) {
        commentsMap.set(id, {
          ...comment,
          orphaned: true,
          orphanedAt: Date.now(),
        });
      }
    });

    if (newlyOrphanedIds.includes(activeThreadId)) {
      activeThreadId = null;
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
 */
function updateCommentSelectedText(state) {
  if (!commentsMap) return;

  const commentMark = state.schema.marks.comment;
  if (!commentMark) return;

  const threadIdsWithMarks = getThreadIdsWithMarks(state);

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

      let rootCommentId = null;
      let rootComment = null;
      commentsMap.forEach((comment, id) => {
        if (comment.threadId === threadId && comment.parentId === null) {
          rootCommentId = id;
          rootComment = comment;
        }
      });

      if (rootComment && rootComment.selectedText !== currentText) {
        const updates = { ...rootComment, selectedText: currentText };
        if (currentContext) {
          updates.positionContext = currentContext;
        }
        commentsMap.set(rootCommentId, updates);
      }
    }
  }
}

/**
 * Check if the current selection is valid for adding a comment.
 * Must be a non-empty text selection OR an image selection.
 *
 * @param {object} state - ProseMirror state
 * @returns {boolean}
 */
export function hasValidCommentSelection(state) {
  if (!state) return false;

  if (isImageSelection(state)) return true;

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

  markOrphanedComments(state);

  updateCommentSelectedText(state);

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.commentThreadId) {
      const isActive = node.attrs.commentThreadId === activeThreadId;
      const highlightClass = isActive
        ? 'da-comment-highlight da-comment-highlight-active'
        : 'da-comment-highlight';
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: highlightClass }));
    }
  });

  if (activeThreadId) {
    const range = findCommentMarkRange(state, activeThreadId);
    if (range && !range.isImage) {
      const attrs = { class: 'da-comment-highlight-active' };
      decorations.push(Decoration.inline(range.from, range.to, attrs));
    }
  }

  if (pendingCommentRange) {
    const { from, to, isImage } = pendingCommentRange;
    if (from < to && to <= state.doc.content.size) {
      const attrs = { class: 'da-comment-highlight-pending' };
      if (isImage) {
        decorations.push(Decoration.node(from, to, attrs));
      } else {
        decorations.push(Decoration.inline(from, to, attrs));
      }
    }
  }

  if (!pendingCommentRange && !activeThreadId && showAddWidget && hasValidCommentSelection(state)) {
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
function handleClick(view, pos) {
  const { state } = view;
  const commentMark = state.schema.marks.comment;
  if (!commentMark) {
    if (activeThreadId) {
      setActiveThread(null);
    }
    return false;
  }

  const $pos = state.doc.resolve(pos);
  const node = $pos.parent.maybeChild($pos.index());

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

  if (node && node.type.name === 'image' && node.attrs.commentThreadId) {
    const { commentThreadId } = node.attrs;
    setActiveThread(commentThreadId);

    const detail = { threadId: commentThreadId };
    window.dispatchEvent(new CustomEvent('da-comment-clicked', { detail }));

    return true;
  }

  if (activeThreadId) {
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
  if (commentsMap) {
    commentsMap.forEach((comment) => {
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

  if (fixTr || tr.docChanged) {
    const docToCheck = fixTr ? fixTr.doc : newState.doc;
    const trToUse = fixTr || newState.tr;
    let hasChanges = !!fixTr;

    validThreadIds.forEach((threadId) => {
      let markStart = null;
      let markEnd = null;

      docToCheck.descendants((node, pos) => {
        if (node.isText) {
          const mark = node.marks.find(
            (m) => m.type === commentMark && m.attrs.threadId === threadId,
          );
          if (mark) {
            if (markStart === null || pos < markStart) {
              markStart = pos;
            }
            if (markEnd === null || pos + node.nodeSize > markEnd) {
              markEnd = pos + node.nodeSize;
            }
          }
        }
      });

      if (markStart !== null && markEnd !== null) {
        docToCheck.nodesBetween(markStart, markEnd, (node, pos) => {
          if (node.isText) {
            const hasMark = node.marks.some(
              (m) => m.type === commentMark && m.attrs.threadId === threadId,
            );
            if (!hasMark) {
              const mark = commentMark.create({ threadId });
              if (!fixTr) {
                fixTr = trToUse;
              }
              fixTr = fixTr.addMark(pos, pos + node.nodeSize, mark);
              hasChanges = true;
            }
          }
        });
      }
    });

    if (hasChanges && fixTr && fixTr.steps.length > 0) {
      return fixTr;
    }
  }

  return fixTr;
}

/**
 * Dispatch selection change event for UI components to react to.
 * @param {object} state - ProseMirror state
 */
function dispatchSelectionChange(state) {
  const { from, to } = state.selection;
  const hasSelection = from !== to || isImageSelection(state);
  window.dispatchEvent(new CustomEvent('da-selection-change', { detail: { hasSelection, from, to } }));
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
          const { from, to } = view.state.selection;
          const { from: prevFrom, to: prevTo } = prevState.selection;
          const selectionKey = `${from}-${to}`;
          const prevSelectionKey = `${prevFrom}-${prevTo}`;

          if (selectionKey !== prevSelectionKey && selectionKey !== lastSelectionKey) {
            lastSelectionKey = selectionKey;
            dispatchSelectionChange(view.state);

            if (addWidgetTimeout) {
              clearTimeout(addWidgetTimeout);
              addWidgetTimeout = null;
            }
            showAddWidget = false;

            const hasSelection = from !== to;
            if (hasSelection && hasValidCommentSelection(view.state)) {
              addWidgetTimeout = setTimeout(() => {
                showAddWidget = true;
                addWidgetTimeout = null;
                const { tr } = view.state;
                view.dispatch(tr.setMeta(commentPluginKey, { showWidget: true }));
              }, 500);
            }
          }
        },
        destroy() {
          if (addWidgetTimeout) {
            clearTimeout(addWidgetTimeout);
            addWidgetTimeout = null;
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
    },
  });
}
