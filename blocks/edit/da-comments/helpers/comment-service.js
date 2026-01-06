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

import { groupCommentsByThread, getRootComment } from './comment-utils.js';

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

  async _restPost(comment) {
    const url = `${this._collabOrigin}/api/v1/comment?doc=${encodeURIComponent(this._docName)}`;
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(comment) };
    if (window.adobeIMS?.isSignedInUser()) {
      const { token } = window.adobeIMS.getAccessToken();
      opts.headers.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`Comment REST POST failed: ${resp.status}`);
  }

  async _restDelete(commentId) {
    const url = `${this._collabOrigin}/api/v1/comment?doc=${encodeURIComponent(this._docName)}`;
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
      await Promise.all(thread.map((c) => this._restDelete(c.id)));
    } else {
      thread.forEach((c) => this._commentsMap.delete(c.id));
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
