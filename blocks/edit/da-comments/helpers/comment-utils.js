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

// Number of characters to capture before/after selection for position context
export const POSITION_CONTEXT_RADIUS = 30;

/**
 * Create a reply to an existing comment
 * @param {Object} parentComment - The parent comment to reply to
 * @param {Object} author - Author object with id, name, email
 * @param {string} content - Reply content
 * @returns {Object} Reply comment object
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
 * @param {Object} comment - The root comment to resolve
 * @param {Object} resolver - User resolving the comment
 * @returns {Object} Updated comment with resolved status
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
 * Unresolve a comment thread (revive a resolved conversation)
 * @param {Object} comment - The root comment to unresolve
 * @returns {Object} Updated comment with resolved status cleared
 */
export function unresolveComment(comment) {
  return {
    ...comment,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
}

/**
 * Group comments by thread
 * @param {Object} commentsMap - Yjs Map containing comments
 * @returns {Map} Map of threadId to array of comments sorted by createdAt
 */
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

/**
 * Get the root comment of a thread
 * @param {Array} threadComments - Array of comments in a thread
 * @returns {Object} Root comment (the one with parentId === null)
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
 * Check if a comment was edited
 * @param {object} comment - Comment object
 * @returns {boolean}
 */
export function wasEdited(comment) {
  if (!comment?.createdAt || !comment?.updatedAt) return false;
  return Math.abs(comment.updatedAt - comment.createdAt) > 1000;
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
 * @param {Object} state - ProseMirror editor state
 * @param {number} from - Selection start position
 * @param {number} to - Selection end position
 * @returns {Object} Position context with textBefore and textAfter
 */
export function getPositionContext(state, from, to) {
  const { doc } = state;
  const docText = doc.textContent;
  const textBefore = docText.slice(Math.max(0, from - POSITION_CONTEXT_RADIUS), from);
  const textAfter = docText.slice(to, Math.min(docText.length, to + POSITION_CONTEXT_RADIUS));

  return {
    textBefore: textBefore.slice(-POSITION_CONTEXT_RADIUS),
    textAfter: textAfter.slice(0, POSITION_CONTEXT_RADIUS),
  };
}

/**
 * Find the best match position for a comment based on position context.
 * Uses a scoring algorithm when text appears multiple times.
 * @param {Object} state - ProseMirror editor state
 * @param {string} selectedText - The text to find
 * @param {Object} positionContext - The stored position context
 * @returns {Object|null} Position range {from, to} or null if not found
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
 * @param {Object} comment - The comment to react to
 * @param {string} emoji - The emoji reaction
 * @param {Object} user - The user adding the reaction
 * @returns {Object} Updated comment with reaction added
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
 * @param {Object} comment - The comment to update
 * @param {string} emoji - The emoji reaction to remove
 * @param {string} userId - The user ID removing the reaction
 * @returns {Object} Updated comment with reaction removed
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
 * @param {Object} comment - The comment to check
 * @param {string} emoji - The emoji to check for
 * @param {string} userId - The user ID to check
 * @returns {boolean} True if user has reacted with this emoji
 */
export function hasUserReacted(comment, emoji, userId) {
  return comment.reactions?.[emoji]?.some((r) => r.userId === userId) || false;
}

/**
 * Get all reactions for a comment as an array
 * @param {Object} comment - The comment
 * @returns {Array} Array of reaction summaries with emoji, users, and count
 */
export function getReactionsList(comment) {
  if (!comment.reactions) return [];
  return Object.entries(comment.reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) => ({ emoji, users, count: users.length }));
}
