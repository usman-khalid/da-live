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

import { CellSelection, NodeSelection } from 'da-y-wrapper';

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
  return threadComments.find((comment) => comment.parentId === null) || threadComments[0];
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

export function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  // eslint-disable-next-line no-bitwise
  return (hash >>> 0).toString(36);
}

export function matchesBoundaryContext(doc, from, to, positionContext) {
  if (!positionContext) return false;

  try {
    const beforeLen = positionContext.textBefore?.length || 0;
    const afterLen = positionContext.textAfter?.length || 0;
    const beforeStart = Math.max(0, from - beforeLen);
    const afterEnd = Math.min(doc.content.size, to + afterLen);

    const before = beforeLen ? doc.textBetween(beforeStart, from, '', '') : '';
    const after = afterLen ? doc.textBetween(to, afterEnd, '', '') : '';

    if (positionContext.textBefore && before !== positionContext.textBefore) return false;
    if (positionContext.textAfter && after !== positionContext.textAfter) return false;
    return beforeLen > 0 || afterLen > 0;
  } catch {
    return false;
  }
}

export function getPositionContext(state, from, to) {
  const { doc } = state;
  const beforeStart = Math.max(0, from - POSITION_CONTEXT_RADIUS * 4);
  const afterEnd = Math.min(doc.content.size, to + POSITION_CONTEXT_RADIUS * 4);

  return {
    textBefore: doc.textBetween(beforeStart, from, '', '').slice(-POSITION_CONTEXT_RADIUS),
    textAfter: doc.textBetween(to, afterEnd, '', '').slice(0, POSITION_CONTEXT_RADIUS),
  };
}

function asRange(match) {
  return { from: match.from, to: match.to };
}

function pickUniqueMatch(matches, predicate) {
  const filtered = matches.filter(predicate);
  return filtered.length === 1 ? asRange(filtered[0]) : null;
}

export function findBestMatchPosition(state, selectedText, positionContext) {
  if (!selectedText || !state) return null;

  const { doc } = state;
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
  if (!positionContext) return null;

  return pickUniqueMatch(
    matches,
    (match) => matchesBoundaryContext(doc, match.from, match.to, positionContext),
  ) || null;
}

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '🚀', '🥳', '✅'];

export function addReaction(comment, emoji, user) {
  const reactions = { ...(comment.reactions || {}) };
  if (!reactions[emoji]) {
    reactions[emoji] = [];
  }
  const existing = reactions[emoji].find((reaction) => reaction.userId === user.id);
  if (!existing) {
    reactions[emoji] = [...reactions[emoji], { userId: user.id, name: user.name }];
  }
  return { ...comment, reactions };
}

export function removeReaction(comment, emoji, userId) {
  const reactions = { ...(comment.reactions || {}) };
  if (reactions[emoji]) {
    reactions[emoji] = reactions[emoji].filter((reaction) => reaction.userId !== userId);
    if (reactions[emoji].length === 0) {
      delete reactions[emoji];
    }
  }
  return { ...comment, reactions };
}

export function hasUserReacted(comment, emoji, userId) {
  return comment.reactions?.[emoji]?.some((reaction) => reaction.userId === userId) || false;
}

export function getReactionsList(comment) {
  if (!comment.reactions) return [];
  return Object.entries(comment.reactions)
    .filter(([, users]) => users.length > 0)
    .map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

export function getSelectionBounds(selection) {
  if (!(selection instanceof CellSelection)) {
    return { from: selection.from, to: selection.to };
  }

  const from = Math.min(...selection.ranges.map((range) => range.$from.pos));
  const to = Math.max(...selection.ranges.map((range) => range.$to.pos));
  return { from, to };
}

export function getSelectionData(state) {
  const { selection } = state;
  const { from, to } = getSelectionBounds(selection);
  const isImage = selection instanceof NodeSelection
    && selection.node?.type.name === 'image';
  const isTable = selection instanceof CellSelection
    || (selection instanceof NodeSelection && selection.node?.type.name === 'table');

  if (from === to && !isImage && !isTable) return null;

  if (isImage) {
    const { node } = selection;
    return {
      from,
      to,
      selectedText: node?.attrs?.alt || '[Image]',
      isImage: true,
      isTable: false,
      positionContext: null,
      imageRef: node?.attrs?.src || null,
    };
  }

  const selectedText = state.doc.textBetween(from, to, '', '');
  if (!selectedText.trim() && !isTable) return null;

  return {
    from,
    to,
    selectedText,
    isImage: false,
    isTable,
    positionContext: getPositionContext(state, from, to),
    imageRef: null,
  };
}

export function buildNewComment(selection, currentUser, content) {
  const commentId = crypto.randomUUID();
  const now = Date.now();

  return {
    id: commentId,
    threadId: commentId,
    parentId: null,
    author: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email || '',
    },
    content,
    createdAt: now,
    updatedAt: now,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    selectedText: selection.selectedText,
    isImage: selection.isImage || false,
    isTable: selection.isTable || false,
    imageRef: selection.imageRef || null,
    positionContext: selection.positionContext || null,
    anchorFrom: selection.from,
    anchorTo: selection.to,
  };
}

export function categorizeThreads(threads) {
  const active = [];
  const orphaned = [];
  const resolved = [];

  for (const [threadId, comments] of threads.entries()) {
    const root = getRootComment(comments);
    const entry = [threadId, comments, root];
    if (root.resolved) resolved.push(entry);
    else if (root.orphaned) orphaned.push(entry);
    else active.push(entry);
  }

  const sortByNewest = (a, b) => b[2].createdAt - a[2].createdAt;
  return {
    active: active.sort(sortByNewest),
    orphaned: orphaned.sort(sortByNewest),
    resolved: resolved.sort(sortByNewest),
  };
}

export function formatOrphanPreview(selectedText, maxChars = 80) {
  if (!selectedText) return '';

  const normalized = selectedText.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

class CommentService extends EventTarget {
  constructor() {
    super();
    this._commentsMap = null;
    this._threads = new Map();
    this._observer = null;
    this._readOnly = false;
    this._collabOrigin = null;
    this._docName = null;
  }

  init(commentsMap, { readOnly = false, collabOrigin = null, docName = null } = {}) {
    this.destroy();
    this._commentsMap = commentsMap;
    this._readOnly = readOnly;
    this._collabOrigin = collabOrigin;
    this._docName = docName;
    this._syncFromMap();
    this._observer = () => {
      this._syncFromMap();
      this.dispatchEvent(new Event('change'));
    };
    this._commentsMap.observe(this._observer);
    this.dispatchEvent(new Event('change'));
  }

  get initialized() {
    return this._commentsMap !== null;
  }

  get readOnly() {
    return this._readOnly;
  }

  get threads() {
    return this._threads;
  }

  get activeCount() {
    let count = 0;
    this._threads.forEach((comments) => {
      const root = getRootComment(comments);
      if (root && !root.resolved && !root.orphaned) count += 1;
    });
    return count;
  }

  _syncFromMap() {
    this._threads = groupCommentsByThread(this._commentsMap);
  }

  _getDocPath() {
    if (!this._docName) return '';
    const url = new URL(this._docName);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'source' || parts.length < 4) return url.pathname;
    return `/${parts.slice(1).join('/').replace(/\.html$/, '')}`;
  }

  async _restPost(comment) {
    const url = `${this._collabOrigin}/api/v1/comment?doc=${encodeURIComponent(this._getDocPath())}`;
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(comment) };
    if (window.adobeIMS?.isSignedInUser()) {
      const { token } = window.adobeIMS.getAccessToken();
      opts.headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`Comment REST POST failed: ${resp.status}`);
  }

  async _restDelete(commentId) {
    const url = `${this._collabOrigin}/api/v1/comment?doc=${encodeURIComponent(this._getDocPath())}`;
    const opts = { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: commentId }) };
    if (window.adobeIMS?.isSignedInUser()) {
      const { token } = window.adobeIMS.getAccessToken();
      opts.headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`Comment REST DELETE failed: ${resp.status}`);
  }

  getComment(id) {
    return this._commentsMap?.get(id) ?? null;
  }

  getThread(threadId) {
    return this._threads.get(threadId) || null;
  }

  getRootComment(threadId) {
    const thread = this.getThread(threadId);
    return thread ? getRootComment(thread) : null;
  }

  async updateComment(id, updater) {
    const comment = this.getComment(id);
    if (!comment) return null;

    const updated = updater(comment);
    if (!updated) return null;

    await this.save(updated);
    return updated;
  }

  async updateRootComment(threadId, updater) {
    const rootComment = this.getRootComment(threadId);
    if (!rootComment) return null;
    return this.updateComment(rootComment.id, updater);
  }

  async markThreadOrphaned(threadId, orphanedAt = Date.now()) {
    return this.updateRootComment(threadId, (rootComment) => {
      if (rootComment.resolved || rootComment.orphaned) return null;

      return {
        ...rootComment,
        orphaned: true,
        orphanedAt,
      };
    });
  }

  async clearThreadOrphaned(threadId) {
    return this.updateRootComment(threadId, (rootComment) => {
      if (!rootComment.orphaned) return null;

      const { orphaned, orphanedAt, ...clean } = rootComment;
      return clean;
    });
  }

  async save(comment) {
    if (!this._commentsMap) return;
    if (this._readOnly) {
      await this._restPost(comment);
    } else {
      this._commentsMap.set(comment.id, comment);
    }
  }

  async remove(id) {
    if (!this._commentsMap) return;
    if (this._readOnly) {
      await this._restDelete(id);
    } else {
      this._commentsMap.delete(id);
    }
  }

  async removeThread(threadId) {
    const thread = this.getThread(threadId);
    if (!thread) return;
    if (this._readOnly) {
      await Promise.all(thread.map((comment) => this._restDelete(comment.id)));
    } else {
      thread.forEach((comment) => this._commentsMap.delete(comment.id));
    }
  }

  destroy() {
    if (this._commentsMap && this._observer) {
      this._commentsMap.unobserve(this._observer);
    }
    this._commentsMap = null;
    this._threads = new Map();
    this._observer = null;
    this._readOnly = false;
    this._collabOrigin = null;
    this._docName = null;
  }
}

const commentService = new CommentService();

export default commentService;
