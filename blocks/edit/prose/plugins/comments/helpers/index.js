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

import { findBestMatchPosition } from '../../../../da-comments/helpers/index.js';

export function isValidRange(state, from, to) {
  return Number.isInteger(from)
    && Number.isInteger(to)
    && from >= 0
    && to <= state.doc.content.size
    && from < to;
}

export function findImagePosition(state, comment) {
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

export function getRootForThread(thread) {
  return thread.find((comment) => comment.parentId === null) || thread[0];
}

export function resolveLiveAnchor(state, root) {
  if (root.isImage) {
    if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
      const node = state.doc.nodeAt(root.anchorFrom);
      if (node?.type.name === 'image') {
        return { from: root.anchorFrom, to: root.anchorTo };
      }
    }
    const imagePos = findImagePosition(state, root);
    return imagePos != null ? { from: imagePos, to: imagePos + 1 } : null;
  }

  if (root.isTable) {
    if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
      return { from: root.anchorFrom, to: root.anchorTo };
    }
    return null;
  }

  if (isValidRange(state, root.anchorFrom, root.anchorTo)) {
    const text = state.doc.textBetween(root.anchorFrom, root.anchorTo, '', '');
    if (text === root.selectedText) {
      return { from: root.anchorFrom, to: root.anchorTo };
    }
  }

  return null;
}

export function resolveSnapshotAnchor(state, root) {
  if (root.isImage || root.isTable || !root.selectedText) return null;
  return findBestMatchPosition(state, root.selectedText, root.positionContext);
}

export function anchorComment(state, root) {
  return resolveLiveAnchor(state, root) || resolveSnapshotAnchor(state, root);
}

export function mapPositionCache(cache, mapping) {
  const mapped = new Map();
  cache.forEach((range, threadId) => {
    mapped.set(threadId, {
      from: mapping.map(range.from, 1),
      to: mapping.map(range.to, -1),
    });
  });
  return mapped;
}

export function resolveCachedThreadRange(state, root, cachedRange) {
  if (!cachedRange) return anchorComment(state, root);
  if (cachedRange.from < cachedRange.to) return cachedRange;
  return anchorComment(state, root);
}

export function rebuildPositionCache(state, threads, previousCache) {
  const nextCache = new Map();
  const threadIds = new Set([
    ...threads.keys(),
    ...previousCache.keys(),
  ]);

  threadIds.forEach((threadId) => {
    const thread = threads.get(threadId);
    if (!thread) return;

    const root = getRootForThread(thread);
    if (!root || root.resolved) return;

    const range = resolveCachedThreadRange(state, root, previousCache.get(threadId));
    if (range) nextCache.set(threadId, range);
  });

  return nextCache;
}

export async function syncOrphanedThreads(commentStore, cache, now = Date.now()) {
  if (!commentStore?.initialized) return [];

  const newlyOrphanedIds = [];

  for (const [threadId, thread] of commentStore.threads.entries()) {
    const root = getRootForThread(thread);
    if (root && !root.resolved) {
      const range = cache.get(threadId);
      const isAnchored = range && range.from < range.to;

      if (!isAnchored && !root.orphaned) {
        await commentStore.markThreadOrphaned(threadId, now);
        newlyOrphanedIds.push(threadId);
      } else if (isAnchored && root.orphaned) {
        await commentStore.clearThreadOrphaned(threadId);
      }
    }
  }

  return newlyOrphanedIds;
}

export function findThreadAtPosition(cache, pos) {
  let threadId = null;
  let bestSize = Infinity;

  cache.forEach((range, id) => {
    if (range.from < range.to && pos >= range.from && pos <= range.to) {
      const size = range.to - range.from;
      if (size < bestSize) {
        bestSize = size;
        threadId = id;
      }
    }
  });

  return threadId;
}
