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

/**
 * Create a reply to an existing comment
 * @param {object} parentComment - The parent comment to reply to
 * @param {object} author - Author object
 * @param {string} content - Reply content
 * @returns {object} Reply comment object
 */
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

/**
 * Resolve a comment thread
 * @param {object} comment - The comment to resolve
 * @param {object} resolver - User resolving the comment
 * @returns {object} Updated comment
 */
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

/**
 * Group comments by thread
 * @param {Map|object} commentsMap - Yjs Map or plain object of comments
 * @returns {Map} Map of threadId -> array of comments
 */
export function groupCommentsByThread(commentsMap) {
  const threads = new Map();

  if (commentsMap.forEach) {
    commentsMap.forEach((comment) => {
      if (comment && comment.threadId) {
        if (!threads.has(comment.threadId)) {
          threads.set(comment.threadId, []);
        }
        threads.get(comment.threadId).push(comment);
      }
    });
  } else {
    Object.values(commentsMap).forEach((comment) => {
      if (comment && comment.threadId) {
        if (!threads.has(comment.threadId)) {
          threads.set(comment.threadId, []);
        }
        threads.get(comment.threadId).push(comment);
      }
    });
  }

  for (const [threadId, comments] of threads) {
    threads.set(threadId, comments.sort((a, b) => a.createdAt - b.createdAt));
  }

  return threads;
}

/**
 * Get the root comment of a thread
 * @param {array} threadComments - Array of comments in a thread
 * @returns {object} Root comment
 */
export function getRootComment(threadComments) {
  return threadComments.find((c) => c.parentId === null) || threadComments[0];
}

/**
 * Format a timestamp for display
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Formatted date string
 */
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

/**
 * Format a timestamp as full date/time for tooltip display
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Full formatted date/time string
 */
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

/**
 * Get user initials from name
 * @param {string} name - User's display name
 * @returns {string} Initials (up to 2 characters)
 */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Extract position context for a selection in ProseMirror.
 * This helps with accurate recovery when selectedText appears multiple times.
 * @param {object} state - ProseMirror state
 * @param {number} from - Selection start
 * @param {number} to - Selection end
 * @returns {object} Position context
 */
export function getPositionContext(state, from, to) {
  const { doc } = state;

  let blockIndex = 0;
  let currentBlockPos = 0;
  let offsetInBlock = 0;

  doc.descendants((node, pos) => {
    if (node.isBlock && pos < from) {
      blockIndex += 1;
      currentBlockPos = pos;
    }
    return true;
  });

  if (currentBlockPos) {
    offsetInBlock = from - currentBlockPos;
  }

  const contextRadius = 30;
  const docText = doc.textContent;
  const textBefore = docText.slice(Math.max(0, from - contextRadius), from);
  const textAfter = docText.slice(to, Math.min(docText.length, to + contextRadius));

  return {
    blockIndex,
    offsetInBlock,
    textBefore: textBefore.slice(-contextRadius),
    textAfter: textAfter.slice(0, contextRadius),
  };
}

/**
 * Find the best match position for a comment based on position context.
 * @param {object} state - ProseMirror state
 * @param {string} selectedText - The text to find
 * @param {object} positionContext - The stored position context
 * @returns {object|null} { from, to } or null if not found
 */
export function findBestMatchPosition(state, selectedText, positionContext) {
  if (!selectedText || !state) return null;

  const { doc } = state;
  const matches = [];

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      let idx = node.text.indexOf(selectedText);
      while (idx !== -1) {
        matches.push({
          from: pos + idx,
          to: pos + idx + selectedText.length,
        });
        idx = node.text.indexOf(selectedText, idx + 1);
      }
    }
    return true;
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  if (!positionContext) return matches[0];

  let bestMatch = matches[0];
  let bestScore = -1;

  const docText = doc.textContent;

  matches.forEach((match) => {
    let score = 0;

    if (positionContext.textBefore) {
      const actualBefore = docText.slice(
        Math.max(0, match.from - positionContext.textBefore.length),
        match.from,
      );
      if (actualBefore === positionContext.textBefore) {
        score += 50;
      } else if (actualBefore.includes(positionContext.textBefore.slice(-10))) {
        score += 20;
      }
    }

    if (positionContext.textAfter) {
      const actualAfter = docText.slice(
        match.to,
        match.to + positionContext.textAfter.length,
      );
      if (actualAfter === positionContext.textAfter) {
        score += 50;
      } else if (actualAfter.includes(positionContext.textAfter.slice(0, 10))) {
        score += 20;
      }
    }

    if (positionContext.blockIndex !== undefined) {
      let currentBlockIndex = 0;
      doc.descendants((node, pos) => {
        if (node.isBlock && pos < match.from) {
          currentBlockIndex += 1;
        }
        return true;
      });

      const blockDiff = Math.abs(currentBlockIndex - positionContext.blockIndex);
      if (blockDiff === 0) {
        score += 30;
      } else if (blockDiff <= 2) {
        score += 15;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = match;
    }
  });

  return bestMatch;
}

/**
 * Default emoji reactions available for comments
 */
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🚀', '🥳', '✅'];

/**
 * Add a reaction to a comment
 * @param {object} comment - The comment to react to
 * @param {string} emoji - The emoji reaction
 * @param {object} user - The user adding the reaction
 * @returns {object} Updated comment with reaction
 */
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

/**
 * Remove a reaction from a comment
 * @param {object} comment - The comment to update
 * @param {string} emoji - The emoji reaction to remove
 * @param {string} userId - The user ID removing the reaction
 * @returns {object} Updated comment without the reaction
 */
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

/**
 * Check if a user has reacted with a specific emoji
 * @param {object} comment - The comment to check
 * @param {string} emoji - The emoji to check for
 * @param {string} userId - The user ID to check
 * @returns {boolean} True if user has reacted with this emoji
 */
export function hasUserReacted(comment, emoji, userId) {
  return comment.reactions?.[emoji]?.some((r) => r.userId === userId) || false;
}

/**
 * Get all reactions for a comment as an array
 * @param {object} comment - The comment
 * @returns {array} Array of { emoji, users, count }
 */
export function getReactionsList(comment) {
  if (!comment.reactions) return [];
  return Object.entries(comment.reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) => ({ emoji, users, count: users.length }));
}
