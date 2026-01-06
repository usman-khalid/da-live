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

export const POSITION_CONTEXT_RADIUS = 80;

export function createReply(parentComment, author, content) {
  const id = crypto.randomUUID();
  const now = Date.now();

  return {
    id,
    threadId: parentComment.threadId,
    parentId: parentComment.id,
    author: {
      id: author.id,
      name: author.name,
      email: author.email || '',
    },
    content,
    createdAt: now,
    updatedAt: now,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
}

export function resolveComment(comment, resolver) {
  return {
    ...comment,
    resolved: true,
    resolvedBy: {
      id: resolver.id,
      name: resolver.name,
    },
    resolvedAt: Date.now(),
  };
}

export function unresolveComment(comment) {
  return {
    ...comment,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
}

export function groupCommentsByThread(commentsMap) {
  const threads = new Map();

  commentsMap.forEach((comment) => {
    if (comment && comment.threadId) {
      if (!threads.has(comment.threadId)) {
        threads.set(comment.threadId, []);
      }
      threads.get(comment.threadId).push(comment);
    }
  });

  for (const [threadId, comments] of threads) {
    threads.set(threadId, comments.sort((a, b) => a.createdAt - b.createdAt));
  }

  return threads;
}

export function getRootComment(threadComments) {
  return threadComments.find((c) => c.parentId === null) || threadComments[0];
}

export function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

export function formatFullTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function wasEdited(comment) {
  if (!comment?.createdAt || !comment?.updatedAt) return false;
  return Math.abs(comment.updatedAt - comment.createdAt) > 1000;
}

export function getInitials(name) {
  if (!name) return '?';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Lightweight djb2 hash returning a base-36 string.
 * Used for paragraph fingerprinting — not cryptographic.
 */
export function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  // eslint-disable-next-line no-bitwise
  return (hash >>> 0).toString(36);
}

/**
 * Extract position context for a selection in ProseMirror.
 * Includes text context (before/after) and structural fingerprint (block index + paragraph hash).
 */
export function getPositionContext(state, from, to) {
  const { doc } = state;
  const beforeStart = Math.max(0, from - POSITION_CONTEXT_RADIUS * 4);
  const afterEnd = Math.min(doc.content.size, to + POSITION_CONTEXT_RADIUS * 4);

  const context = {
    textBefore: doc.textBetween(beforeStart, from, '', '').slice(-POSITION_CONTEXT_RADIUS),
    textAfter: doc.textBetween(to, afterEnd, '', '').slice(0, POSITION_CONTEXT_RADIUS),
    blockIndex: -1,
    paragraphFingerprint: null,
  };

  try {
    const resolved = doc.resolve(from);
    if (resolved.depth >= 1) {
      context.blockIndex = resolved.index(1);
      const blockNode = resolved.node(1);
      if (blockNode) {
        context.paragraphFingerprint = simpleHash(blockNode.textContent);
      }
    }
  } catch {
    // Position resolution can fail on edge cases
  }

  return context;
}

/**
 * Find the best match position for a comment based on position context.
 * Uses a scoring algorithm when text appears multiple times.
 * @param {Object} state - ProseMirror editor state
 * @param {string} selectedText - The text to find
 * @param {Object} positionContext - The stored position context
 * @param {number|null} currentFrom - Current mapped position hint (for positional continuity)
 * @returns {Object|null} Position range {from, to} or null if not found
 */
export function findBestMatchPosition(state, selectedText, positionContext, currentFrom = null) {
  if (!selectedText || !state) return null;

  const { doc } = state;

  // Build a map from text-content offset → doc position.
  // This lets us search the full concatenated text and map hits
  // back to ProseMirror positions, even across paragraph boundaries.
  const posMap = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) {
        posMap.push(pos + i);
      }
    }
    return true;
  });

  const fullText = doc.textContent;
  const matches = [];
  let searchFrom = 0;
  while (searchFrom <= fullText.length - selectedText.length) {
    const idx = fullText.indexOf(selectedText, searchFrom);
    if (idx === -1) break;
    const from = posMap[idx];
    const to = posMap[idx + selectedText.length - 1] + 1;
    if (from != null && to != null) matches.push({ from, to, textIdx: idx });
    searchFrom = idx + 1;
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return { from: matches[0].from, to: matches[0].to };
  if (!positionContext && currentFrom == null) return { from: matches[0].from, to: matches[0].to };

  let bestMatch = matches[0];
  let bestScore = -1;

  matches.forEach((match) => {
    let score = 0;

    if (currentFrom != null) {
      const drift = Math.abs(match.from - currentFrom);
      if (drift === 0) score += 80;
      else if (drift <= 5) score += 60;
      else if (drift <= 20) score += 30;
    }

    if (positionContext) {
      if (positionContext.textBefore) {
        const sliceStart = Math.max(0, match.textIdx - positionContext.textBefore.length);
        const before = fullText.slice(sliceStart, match.textIdx);
        if (before === positionContext.textBefore) {
          score += 50;
        } else {
          const tail = positionContext.textBefore.slice(-20);
          if (tail && before.endsWith(tail)) score += 30;
          else if (before.includes(positionContext.textBefore.slice(-10))) score += 15;
        }
      }

      if (positionContext.textAfter) {
        const afterStart = match.textIdx + selectedText.length;
        const after = fullText.slice(afterStart, afterStart + positionContext.textAfter.length);
        if (after === positionContext.textAfter) {
          score += 50;
        } else {
          const head = positionContext.textAfter.slice(0, 20);
          if (head && after.startsWith(head)) score += 30;
          else if (after.includes(positionContext.textAfter.slice(0, 10))) score += 15;
        }
      }

      if (positionContext.blockIndex != null && positionContext.blockIndex >= 0) {
        try {
          const resolved = doc.resolve(match.from);
          if (resolved.depth >= 1) {
            const matchBlockIndex = resolved.index(1);
            if (matchBlockIndex === positionContext.blockIndex) {
              score += 25;
              if (positionContext.paragraphFingerprint) {
                const blockNode = resolved.node(1);
                if (simpleHash(blockNode.textContent) === positionContext.paragraphFingerprint) {
                  score += 25;
                }
              }
            } else {
              const dist = Math.abs(matchBlockIndex - positionContext.blockIndex);
              score -= Math.min(dist * 2, 10);
            }
          }
        } catch { /* position resolution can fail */ }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = match;
    }
  });

  return { from: bestMatch.from, to: bestMatch.to };
}

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🚀', '🥳', '✅'];

export function addReaction(comment, emoji, user) {
  const reactions = { ...(comment.reactions || {}) };
  if (!reactions[emoji]) {
    reactions[emoji] = [];
  }
  const existing = reactions[emoji].find((r) => r.userId === user.id);
  if (!existing) {
    reactions[emoji] = [...reactions[emoji], { userId: user.id, name: user.name }];
  }
  return { ...comment, reactions };
}

export function removeReaction(comment, emoji, userId) {
  const reactions = { ...(comment.reactions || {}) };
  if (reactions[emoji]) {
    reactions[emoji] = reactions[emoji].filter((r) => r.userId !== userId);
    if (reactions[emoji].length === 0) {
      delete reactions[emoji];
    }
  }
  return { ...comment, reactions };
}

export function hasUserReacted(comment, emoji, userId) {
  return comment.reactions?.[emoji]?.some((r) => r.userId === userId) || false;
}

export function getReactionsList(comment) {
  if (!comment.reactions) return [];
  return Object.entries(comment.reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) => ({ emoji, users, count: users.length }));
}
