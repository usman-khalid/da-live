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

import { LitElement, html, nothing } from 'da-lit';
import getSheet from '../../shared/sheet.js';
import { renderStatusToast } from '../../shared/status-toast/status-toast.js';
import {
  groupCommentsByThread,
  getRootComment,
  createReply,
  resolveComment,
  unresolveComment,
  formatTimestamp,
  formatFullTimestamp,
  getInitials,
  getPositionContext,
  findBestMatchPosition,
  REACTION_EMOJIS,
  addReaction,
  removeReaction,
  hasUserReacted,
  getReactionsList,
} from './helpers/comment-utils.js';
import {
  setCommentsMap,
  setActiveThread,
  applyCommentMark,
  removeCommentMark,
  hasValidCommentSelection,
  setPendingCommentRange,
  clearPendingCommentRange,
  isImageSelection,
} from '../prose/plugins/comments/commentPlugin.js';

import { generateColor } from '../../shared/utils.js';

const sheet = await getSheet('/blocks/edit/da-comments/da-comments.css');
const toastSheet = await getSheet('/blocks/shared/status-toast/status-toast.css');

export default class DaComments extends LitElement {
  static properties = {
    commentsMap: { attribute: false },
    currentUser: { attribute: false },
    open: { type: Boolean },
    _threads: { state: true },
    _activeThreadId: { state: true },
    _showResolved: { state: true },
    _showOrphaned: { state: true },
    _isCreatingNew: { state: true },
    _pendingSelection: { state: true },
    _commentText: { state: true },
    _replyingTo: { state: true },
    _menuOpen: { state: true },
    _editingCommentId: { state: true },
    _editText: { state: true },
    _hasValidSelection: { state: true },
    _status: { state: true },
    _reactionPickerCommentId: { state: true },
    _confirmDeleteThread: { state: true },
    _pendingScrollToComment: { state: true },
  };

  constructor() {
    super();
    this._threads = new Map();
    this._activeThreadId = null;
    this._showResolved = false;
    this._showOrphaned = false;
    this._isCreatingNew = false;
    this._pendingSelection = null;
    this._commentText = '';
    this._replyingTo = null;
    this._menuOpen = null;
    this._editingCommentId = null;
    this._editText = '';
    this._hasValidSelection = false;
    this._reactionPickerCommentId = null;
    this._confirmDeleteThread = null;
    this._pendingScrollToComment = null;
    this.handleCommentClicked = this.handleCommentClicked.bind(this);
    this.handleActiveChanged = this.handleActiveChanged.bind(this);
    this.handleOrphanedComments = this.handleOrphanedComments.bind(this);
    this.handleOutsideClick = this.handleOutsideClick.bind(this);
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.handleCommentAddRequest = this.handleCommentAddRequest.bind(this);
  }

  resetFormState() {
    this._isCreatingNew = false;
    this._pendingSelection = null;
    this._replyingTo = null;
    this._commentText = '';
    this._menuOpen = null;
    this._editingCommentId = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sheet, toastSheet];
    window.addEventListener('da-comment-clicked', this.handleCommentClicked);
    window.addEventListener('da-comment-active-changed', this.handleActiveChanged);
    window.addEventListener('da-comments-orphaned', this.handleOrphanedComments);
    window.addEventListener('da-selection-change', this.handleSelectionChange);
    window.addEventListener('da-comment-add', this.handleCommentAddRequest);
    document.addEventListener('click', this.handleOutsideClick);
    import('../../shared/da-dialog/da-dialog.js');
    this.checkUrlForComment();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('da-comment-clicked', this.handleCommentClicked);
    window.removeEventListener('da-comment-active-changed', this.handleActiveChanged);
    window.removeEventListener('da-comments-orphaned', this.handleOrphanedComments);
    window.removeEventListener('da-selection-change', this.handleSelectionChange);
    window.removeEventListener('da-comment-add', this.handleCommentAddRequest);
    document.removeEventListener('click', this.handleOutsideClick);
  }

  checkUrlForComment() {
    const url = new URL(window.location.href);
    const commentId = url.searchParams.get('comment');
    if (commentId) {
      this.emitRequestOpen();
      this.openInitialComment(commentId);
    }
  }

  emitRequestOpen() {
    const opts = { bubbles: true, composed: true };
    this.dispatchEvent(new CustomEvent('request-open', opts));
  }

  emitCountChanged(count) {
    const opts = { bubbles: true, composed: true, detail: count };
    this.dispatchEvent(new CustomEvent('count-changed', opts));
  }

  handleCommentAddRequest() {
    this.emitRequestOpen();
    this.startAddComment();
  }

  handleOutsideClick(event) {
    if (!this._menuOpen && !this._reactionPickerCommentId) return;

    const path = event.composedPath();
    const isInsideMenu = path.some((el) => el.classList?.contains('da-comment-menu'));
    const isInsideReactionPicker = path.some(
      (el) => el.classList?.contains('da-reactions') || el.classList?.contains('da-reaction-picker'),
    );

    if (this._menuOpen && !isInsideMenu) {
      this._menuOpen = null;
    }
    if (this._reactionPickerCommentId && !isInsideReactionPicker) {
      this._reactionPickerCommentId = null;
    }
  }

  /**
   * Check if current user is anonymous
   */
  isAnonymousUser() {
    return !this.currentUser?.id || this.currentUser.id.startsWith('anonymous-');
  }

  /**
   * Check if current user can edit a comment (must be the author)
   */
  canEditComment(comment) {
    if (!comment || !this.currentUser) return false;
    return this.currentUser.id === comment.author?.id;
  }

  /**
   * Handle orphaned comments (text was deleted from document)
   * The plugin already deleted the comments from the map,
   * this just handles UI updates
   */
  handleOrphanedComments(event) {
    const { orphanedIds } = event.detail;
    if (!orphanedIds) return;

    if (orphanedIds.includes(this._activeThreadId)) {
      this._activeThreadId = null;
      setActiveThread(null);
    }

    this.updateThreads();
  }

  /**
   * Handle selection change events from ProseMirror plugin
   */
  handleSelectionChange() {
    const isValid = window.view ? hasValidCommentSelection(window.view.state) : false;
    if (this._hasValidSelection !== isValid) {
      this._hasValidSelection = isValid;
      if (!isValid && this._isCreatingNew) {
        this.cancelNewComment();
      }
    }
  }

  scrollToCommentHighlight(threadId) {
    const daContent = document.querySelector('da-content');
    if (!daContent?.shadowRoot) return;

    const daEditor = daContent.shadowRoot.querySelector('da-editor');
    if (!daEditor?.shadowRoot) return;

    const highlight = daEditor.shadowRoot.querySelector(`.da-comment-highlight[data-comment-thread="${threadId}"]`);
    if (highlight) {
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  handleClose() {
    if (this._isCreatingNew) {
      this.cancelNewComment();
    }
    clearPendingCommentRange();
    const opts = { bubbles: true, composed: true };
    const event = new CustomEvent('close', opts);
    this.dispatchEvent(event);
  }

  /**
   * Handle click on comment highlight in document.
   * Opens the thread detail view for the clicked comment.
   */
  handleCommentClicked(event) {
    const { threadId } = event.detail;
    if (!threadId) return;

    this.emitRequestOpen();
    this._activeThreadId = threadId;
    this.resetFormState();
    this.requestUpdate();
    requestAnimationFrame(() => {
      const threadDetail = this.shadowRoot?.querySelector('.da-thread-detail');
      if (threadDetail) {
        threadDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /**
   * Handle active thread changes from the plugin (e.g., clicking outside a comment clears it).
   */
  handleActiveChanged(event) {
    const { threadId } = event.detail;

    if (this._activeThreadId !== threadId) {
      this._activeThreadId = threadId;
      if (!threadId) {
        this.resetFormState();
      }
      this.requestUpdate();
    }
  }

  updated(changedProps) {
    if (changedProps.has('commentsMap') && this.commentsMap) {
      setCommentsMap(this.commentsMap);
      this.updateThreads();

      if (!this.commentsMap.daCommentsObserverSet) {
        this.commentsMap.daCommentsObserverSet = true;
        this.commentsMap.observe(() => {
          this.updateThreads();
        });
      }
    }

    if (changedProps.has('_threads')) {
      this.emitCountChanged(this.commentCount);
    }

    if (changedProps.has('_isCreatingNew') && this._isCreatingNew) {
      this.focusCommentTextarea();
    }

    if (changedProps.has('open') && this.open && !changedProps.get('open')) {
      if (this._hasValidSelection && !this._isCreatingNew && !this._activeThreadId) {
        queueMicrotask(() => this.startAddComment());
      }
    }

    if (this._pendingScrollToComment && this._threads.has(this._pendingScrollToComment)) {
      const targetId = this._pendingScrollToComment;
      this._pendingScrollToComment = null;
      requestAnimationFrame(() => {
        this.scrollToCommentHighlight(targetId);
      });
    }
  }

  get commentCount() {
    let count = 0;
    this._threads.forEach((comments) => {
      const root = getRootComment(comments);
      if (root && !root.resolved && !root.orphaned) {
        count += 1;
      }
    });
    return count;
  }

  /**
   * Open a specific comment thread directly (from URL parameter)
   */
  openInitialComment(commentId) {
    this._activeThreadId = commentId;
    this._pendingScrollToComment = commentId;
    setActiveThread(commentId);

    const url = new URL(window.location.href);
    url.searchParams.delete('comment');
    window.history.replaceState({}, '', url.toString());
  }

  /**
   * Focus the new comment textarea after render
   */
  focusCommentTextarea() {
    requestAnimationFrame(() => {
      const textarea = this.shadowRoot?.querySelector('.da-comment-form textarea');
      if (textarea) {
        textarea.focus();
      }
    });
  }

  updateThreads() {
    if (!this.commentsMap) return;
    this._threads = groupCommentsByThread(this.commentsMap);

    if (this._activeThreadId && !this._threads.has(this._activeThreadId)) {
      this._activeThreadId = null;
      setActiveThread(null);
    }

    this.requestUpdate();
  }

  selectThread(threadId) {
    this._activeThreadId = threadId;
    this.resetFormState();
    setActiveThread(threadId);
    this._pendingScrollToComment = threadId;
    this.requestUpdate();
  }

  backToList() {
    this._activeThreadId = null;
    this.resetFormState();
    setActiveThread(null);
  }

  handleTextareaInput(event) {
    this._commentText = event.target.value;
  }

  handleEditInput(event) {
    this._editText = event.target.value;
  }

  toggleReactionPicker(commentId) {
    if (this._reactionPickerCommentId === commentId) {
      this._reactionPickerCommentId = null;
    } else {
      this._reactionPickerCommentId = commentId;
    }
  }

  toggleReaction(comment, emoji) {
    if (!this.currentUser || this.isAnonymousUser()) return;

    const userReacted = hasUserReacted(comment, emoji, this.currentUser.id);
    let updatedComment;

    if (userReacted) {
      updatedComment = removeReaction(comment, emoji, this.currentUser.id);
    } else {
      updatedComment = addReaction(comment, emoji, this.currentUser);
    }

    this.commentsMap.set(comment.id, updatedComment);
    this._reactionPickerCommentId = null;
  }

  startAddComment() {
    if (!window.view || !this.currentUser) return;

    if (this.isAnonymousUser()) return;

    const { state } = window.view;
    const { from, to } = state.selection;
    const isImage = isImageSelection(state);

    if (from === to && !isImage) return;

    let selectedText;
    let positionContext = null;

    if (isImage) {
      const { node } = state.selection;
      selectedText = node?.attrs?.alt || '[Image]';
    } else {
      selectedText = state.doc.textBetween(from, to, '', '');
      if (!selectedText.trim() || /^[\s\u00A0]+$/.test(selectedText)) {
        return;
      }
      positionContext = getPositionContext(state, from, to);
    }

    this._pendingSelection = { from, to, selectedText, isImage, positionContext };
    this._isCreatingNew = true;
    this._activeThreadId = null;
    this._commentText = '';
    setActiveThread(null);

    setPendingCommentRange({ from, to, isImage });
  }

  cancelNewComment() {
    this.resetFormState();
    clearPendingCommentRange();
  }

  submitNewComment(event) {
    event.preventDefault();
    const content = this._commentText.trim();

    if (!content || !this._pendingSelection) return;

    const commentId = crypto.randomUUID();
    const { selectedText, isImage, positionContext } = this._pendingSelection;

    const comment = {
      id: commentId,
      threadId: commentId,
      parentId: null,
      author: {
        id: this.currentUser.id,
        name: this.currentUser.name,
        email: this.currentUser.email || '',
      },
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      selectedText,
      isImage: isImage || false,
      positionContext: positionContext || null,
    };

    this.commentsMap.set(comment.id, comment);

    const markOptions = { selectedText, positionContext, isImage };
    if (!applyCommentMark(commentId, markOptions)) {
      this.commentsMap.delete(comment.id);
      this.cancelNewComment();
      return;
    }

    this._activeThreadId = comment.threadId;
    this.resetFormState();
    setActiveThread(comment.threadId);
    clearPendingCommentRange();
  }

  submitReply(event) {
    event.preventDefault();
    const content = this._commentText.trim();

    if (!content || !this._replyingTo) return;

    const rootComment = this._threads.get(this._activeThreadId)?.[0];
    if (rootComment) {
      const reply = createReply(rootComment, this.currentUser, content);
      this.commentsMap.set(reply.id, reply);
    }

    this._replyingTo = null;
    this._commentText = '';
  }

  toggleMenu(event, commentId) {
    event.stopPropagation();
    this._menuOpen = this._menuOpen === commentId ? null : commentId;
  }

  startEdit(commentId) {
    const comment = this.commentsMap.get(commentId);
    if (comment) {
      this._editingCommentId = commentId;
      this._editText = comment.content;
      this._menuOpen = null;
    }
  }

  saveEdit(event) {
    event.preventDefault();
    const content = this._editText.trim();
    if (!content || !this._editingCommentId) return;

    const comment = this.commentsMap.get(this._editingCommentId);
    if (comment) {
      this.commentsMap.set(this._editingCommentId, {
        ...comment,
        content,
        updatedAt: Date.now(),
      });
    }

    this._editingCommentId = null;
    this._editText = '';
  }

  cancelEdit() {
    this._editingCommentId = null;
    this._editText = '';
  }

  deleteComment(commentId) {
    this._menuOpen = null;

    const comments = this._threads.get(this._activeThreadId);
    if (!comments) return;

    const rootComment = getRootComment(comments);
    const isRoot = rootComment?.id === commentId;

    if (isRoot && comments.length > 1) {
      this._confirmDeleteThread = { threadId: this._activeThreadId };
      return;
    }

    if (isRoot) {
      removeCommentMark(this._activeThreadId);
      this.commentsMap.delete(commentId);
      this._activeThreadId = null;
      setActiveThread(null);
    } else {
      this.commentsMap.delete(commentId);
    }
  }

  confirmDeleteThread() {
    if (!this._confirmDeleteThread) return;

    const { threadId } = this._confirmDeleteThread;
    const comments = this._threads.get(threadId);
    if (!comments) {
      this._confirmDeleteThread = null;
      return;
    }

    removeCommentMark(threadId);
    comments.forEach((c) => {
      this.commentsMap.delete(c.id);
    });

    this._activeThreadId = null;
    this._confirmDeleteThread = null;
    setActiveThread(null);
  }

  cancelDeleteConfirm() {
    this._confirmDeleteThread = null;
  }

  resolveThread(threadId) {
    const comments = this._threads.get(threadId);
    if (!comments) return;

    const rootComment = getRootComment(comments);
    const resolved = resolveComment(rootComment, this.currentUser);
    this.commentsMap.set(rootComment.id, resolved);

    removeCommentMark(threadId);

    this._activeThreadId = null;
    this._replyingTo = null;
    this._menuOpen = null;
    setActiveThread(null);
  }

  unresolveThread(threadId) {
    const comments = this._threads.get(threadId);
    if (!comments) return;

    const rootComment = getRootComment(comments);
    if (!rootComment) return;

    // Try to re-add the mark if we can find the original text
    const { selectedText, positionContext } = rootComment;
    let markRestored = false;

    if (selectedText && window.view) {
      const { state } = window.view;
      const match = findBestMatchPosition(state, selectedText, positionContext);

      if (match) {
        const commentMark = state.schema.marks.comment;
        if (commentMark) {
          const tr = state.tr.addMark(match.from, match.to, commentMark.create({ threadId }));
          window.view.dispatch(tr);
          markRestored = true;
        }
      }
    }

    // Unresolve the comment
    const unresolved = unresolveComment(rootComment);
    this.commentsMap.set(rootComment.id, unresolved);

    if (!markRestored) {
      // Mark as orphaned since we couldn't find the text
      this.commentsMap.set(rootComment.id, {
        ...unresolved,
        orphaned: true,
        orphanedAt: Date.now(),
      });
      this.setStatus('Comment unresolved but detached', 'Original text could not be found', 'info');
    }
  }

  deleteThread(threadId) {
    const comments = this._threads.get(threadId);
    if (!comments) return;

    removeCommentMark(threadId);

    comments.forEach((comment) => {
      this.commentsMap.delete(comment.id);
    });

    this._activeThreadId = null;
    this._replyingTo = null;
    this._menuOpen = null;
    setActiveThread(null);
  }

  setStatus(text, description, type = 'info') {
    this._status = text ? { type, text, description } : null;
  }

  copyCommentLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('comment', this._activeThreadId);
    navigator.clipboard.writeText(url.toString());
    this._menuOpen = null;

    this.setStatus('Copied', 'The link was copied to the clipboard.');
    setTimeout(() => { this.setStatus(); }, 3000);
  }

  getThreadsSorted() {
    const threadsArray = Array.from(this._threads.entries());
    return threadsArray.sort((a, b) => {
      const rootA = getRootComment(a[1]);
      const rootB = getRootComment(b[1]);
      return rootB.createdAt - rootA.createdAt;
    });
  }

  renderAvatar(author) {
    const color = generateColor(author.email || author.id);
    const initials = getInitials(author.name);
    return html`
      <div class="da-comment-avatar" style="background-color: ${color}">
        ${initials}
      </div>
    `;
  }

  renderThreadPreview(threadId, comments) {
    const rootComment = getRootComment(comments);
    const replyCount = comments.length - 1;
    const isResolved = rootComment.resolved;
    const isOrphaned = rootComment.orphaned;

    let statusClass = '';
    if (isResolved) statusClass = 'resolved';
    else if (isOrphaned) statusClass = 'orphaned';

    return html`
      <li class="da-thread-preview ${statusClass}"
          @click=${() => this.selectThread(threadId)}>
        <div class="da-thread-preview-header">
          ${this.renderAvatar(rootComment.author)}
          <div class="da-thread-preview-meta">
            <span class="da-thread-preview-author">${rootComment.author.name}</span>
            <span class="da-thread-preview-time" title="${formatFullTimestamp(rootComment.createdAt)}">${formatTimestamp(rootComment.createdAt)}</span>
          </div>
          ${isResolved ? html`<span class="da-resolved-tag">Resolved</span>` : nothing}
          ${isOrphaned ? html`<span class="da-orphaned-tag">Detached</span>` : nothing}
        </div>
        <p class="da-thread-preview-content">${rootComment.content}</p>
        ${replyCount > 0 ? html`
          <span class="da-thread-preview-replies">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
        ` : nothing}
      </li>
    `;
  }

  renderComment(comment, isRoot = false, isResolved = false) {
    const isEditing = this._editingCommentId === comment.id;

    if (isEditing) {
      return html`
        <div class="da-comment ${isRoot ? 'da-comment-root' : 'da-comment-reply'}">
          <div class="da-comment-header">
            ${this.renderAvatar(comment.author)}
            <div class="da-comment-meta">
              <span class="da-comment-author">${comment.author.name}</span>
              <span class="da-comment-time" title="${formatFullTimestamp(comment.createdAt)}">${formatTimestamp(comment.createdAt)}</span>
            </div>
          </div>
          <form @submit=${this.saveEdit} class="da-comment-form da-edit-form">
            <textarea
              .value=${this._editText}
              @input=${this.handleEditInput}
              @keydown=${(e) => {
                if (e.key === 'Escape') this.cancelEdit();
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  this.saveEdit(e);
                }
              }}
            ></textarea>
            <div class="da-comment-form-actions">
              <button type="button" class="da-btn-cancel" @click=${this.cancelEdit}>Cancel</button>
              <button
                type="submit"
                class="da-btn-submit"
                ?disabled=${!this._editText.trim()}
              >Save</button>
            </div>
          </form>
        </div>
      `;
    }

    const canEdit = this.canEditComment(comment);
    const showActions = !isResolved && (isRoot || canEdit);

    return html`
      <div class="da-comment ${isRoot ? 'da-comment-root' : 'da-comment-reply'}">
        <div class="da-comment-header">
          ${this.renderAvatar(comment.author)}
          <div class="da-comment-meta">
            <span class="da-comment-author">${comment.author.name}</span>
            <span class="da-comment-time" title="${formatFullTimestamp(comment.createdAt)}">${formatTimestamp(comment.createdAt)}</span>
          </div>
          ${showActions ? html`
            <div class="da-comment-header-actions">
              ${isRoot ? html`
                <button
                  class="da-btn-resolve-icon"
                  @click=${() => this.resolveThread(this._activeThreadId)}
                  title="Resolve"
                >
                  <span class="da-icon da-icon-checkmark"></span>
                </button>
              ` : nothing}
              ${this.renderCommentMenu(comment, isRoot, canEdit)}
            </div>
          ` : nothing}
        </div>
        <div class="da-comment-content">${comment.content}</div>
        ${this.renderReactions(comment, isResolved)}
      </div>
    `;
  }

  renderReactions(comment, isResolved = false) {
    const reactions = getReactionsList(comment);
    const showPicker = this._reactionPickerCommentId === comment.id;
    const canReact = !isResolved && this.currentUser && !this.isAnonymousUser();

    return html`
      <div class="da-reactions">
        ${reactions.map((r) => html`
          <button
            class="da-reaction ${hasUserReacted(comment, r.emoji, this.currentUser?.id) ? 'da-reaction-active' : ''}"
            @click=${() => canReact && this.toggleReaction(comment, r.emoji)}
            title="${r.users.map((u) => u.name).join(', ')}"
            ?disabled=${!canReact}
          >
            <span class="da-reaction-emoji">${r.emoji}</span>
            <span class="da-reaction-count">${r.count}</span>
          </button>
        `)}
        ${canReact ? html`
          <div class="da-reaction-picker-wrapper">
            <button
              class="da-reaction-add"
              @click=${() => this.toggleReactionPicker(comment.id)}
              title="Add reaction"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"></circle>
                <circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"></circle>
              </svg>
            </button>
            ${showPicker ? html`
              <div class="da-reaction-picker">
                ${REACTION_EMOJIS.map((emoji) => html`
                  <button
                    class="da-reaction-picker-item"
                    @click=${() => this.toggleReaction(comment, emoji)}
                  >
                    ${emoji}
                  </button>
                `)}
              </div>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  renderCommentMenu(comment, isRoot, canEdit) {
    if (!canEdit && !isRoot) return nothing;

    const isOpen = this._menuOpen === comment.id;

    return html`
      <div class="da-comment-menu">
        <button class="da-btn-menu" @click=${(e) => this.toggleMenu(e, comment.id)} title="More options">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2"></circle>
            <circle cx="12" cy="12" r="2"></circle>
            <circle cx="12" cy="19" r="2"></circle>
          </svg>
        </button>
        ${isOpen ? html`
          <div class="da-menu-dropdown">
            ${canEdit ? html`
              <button class="da-menu-item" @click=${() => this.startEdit(comment.id)}>Edit</button>
              <button class="da-menu-item" @click=${() => this.deleteComment(comment.id)}>Delete</button>
            ` : nothing}
            ${isRoot ? html`
              <button class="da-menu-item" @click=${this.copyCommentLink}>Get link to this comment</button>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  renderThreadActions(isResolved, isReplying, rootComment) {
    if (isResolved) {
      return html`
        <div class="da-comment-thread-actions">
          <button class="da-btn-unresolve" @click=${() => this.unresolveThread(this._activeThreadId)}>
            Reopen
          </button>
          <button class="da-btn-delete" @click=${() => this.deleteThread(this._activeThreadId)}>
            Delete thread
          </button>
        </div>
      `;
    }

    if (this.isAnonymousUser()) {
      return html`<p class="da-sign-in-notice">Sign in to reply</p>`;
    }

    return html`
      <form @submit=${this.submitReply} class="da-comment-form da-reply-form">
        <textarea
          placeholder="Reply..."
          rows="1"
          .value=${isReplying ? this._commentText : ''}
          @input=${this.handleTextareaInput}
          @focus=${() => {
            this._replyingTo = rootComment.id;
            this._commentText = '';
          }}
          @keydown=${(e) => {
            if (e.key === 'Escape') {
              this._replyingTo = null;
              this._commentText = '';
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              this.submitReply(e);
            }
          }}
        ></textarea>
        ${isReplying ? html`
          <div class="da-comment-form-actions">
            <button type="button" class="da-btn-cancel" @click=${() => {
              this._replyingTo = null;
              this._commentText = '';
            }}>Cancel</button>
            <button
              type="submit"
              class="da-btn-submit"
              ?disabled=${!this._commentText.trim()}
            >Reply</button>
          </div>
        ` : nothing}
      </form>
    `;
  }

  renderNewCommentForm() {
    return html`
      <div class="da-thread-detail">
        <button class="da-back-btn" @click=${this.cancelNewComment}>
          <span class="da-icon da-icon-chevron-left"></span>
          Back
        </button>
        <div class="da-comment-card">
          <div class="da-comment-header">
            ${this.renderAvatar(this.currentUser)}
            <div class="da-comment-meta">
              <span class="da-comment-author">${this.currentUser.name}</span>
            </div>
          </div>
          <form @submit=${this.submitNewComment} class="da-comment-form">
            <textarea
              placeholder="Add a comment..."
              rows="3"
              autofocus
              .value=${this._commentText}
              @input=${this.handleTextareaInput}
              @keydown=${(e) => {
                if (e.key === 'Escape') this.cancelNewComment();
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  this.submitNewComment(e);
                }
              }}
            ></textarea>
            <div class="da-comment-form-actions">
              <button type="button" class="da-btn-cancel" @click=${this.cancelNewComment}>Cancel</button>
              <button
                type="submit"
                class="da-btn-submit"
                ?disabled=${!this._commentText.trim()}
              >Comment</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  renderThreadDetail() {
    const comments = this._threads.get(this._activeThreadId);
    if (!comments || comments.length === 0) return nothing;

    const rootComment = getRootComment(comments);
    const replies = comments.filter((c) => c.parentId !== null);
    const isResolved = rootComment.resolved;
    const isOrphaned = rootComment.orphaned;
    const isReplying = this._replyingTo === rootComment.id;

    let cardClass = '';
    if (isResolved) cardClass = 'resolved';
    else if (isOrphaned) cardClass = 'orphaned';

    return html`
      <div class="da-thread-detail">
        <button class="da-back-btn" @click=${this.backToList}>
          <span class="da-icon da-icon-chevron-left"></span>
          Back
        </button>
        <div class="da-comment-card ${cardClass}">
          ${isResolved ? html`
            <div class="da-resolved-badge">Resolved</div>
          ` : nothing}
          ${isOrphaned ? html`
            <div class="da-orphaned-badge">
              <span class="da-icon-info"></span>
              Original content was deleted
            </div>
          ` : nothing}

          ${this.renderComment(rootComment, true, isResolved)}

          ${replies.length > 0 ? html`
            <div class="da-comment-replies">
              ${replies.map((reply) => this.renderComment(reply, false, isResolved))}
            </div>
          ` : nothing}

          ${this.renderThreadActions(isResolved, isReplying, rootComment)}
          
        </div>
      </div>
    `;
  }

  renderList() {
    const sortedThreads = this.getThreadsSorted();
    const activeThreads = sortedThreads.filter(([, comments]) => {
      const root = getRootComment(comments);
      return !root.resolved && !root.orphaned;
    });
    const orphanedThreads = sortedThreads.filter(([, comments]) => {
      const root = getRootComment(comments);
      return root.orphaned && !root.resolved;
    });
    const resolvedThreads = sortedThreads.filter(
      ([, comments]) => getRootComment(comments).resolved,
    );

    const canAddComment = this._hasValidSelection && !this.isAnonymousUser();
    let buttonTitle = 'Select text to comment';
    if (this.isAnonymousUser()) {
      buttonTitle = 'Sign in to add comments';
    } else if (this._hasValidSelection) {
      buttonTitle = 'Add comment';
    }

    return html`
      <div class="da-comments-list">
        <button
          class="da-add-comment-btn"
          @click=${this.startAddComment}
          ?disabled=${!canAddComment}
          title=${buttonTitle}
        >
          <span class="da-icon da-icon-add"></span>
          Add comment
        </button>

        ${activeThreads.length > 0 ? html`
          <ul class="da-threads-list">
            ${activeThreads.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
          </ul>
        ` : html`
          <p class="da-no-comments">No comments yet</p>
        `}

        ${orphanedThreads.length > 0 ? html`
          <div class="da-orphaned-section">
            <button class="da-toggle-orphaned" @click=${() => { this._showOrphaned = !this._showOrphaned; }}>
              ${this._showOrphaned ? 'Hide' : 'Show'} detached (${orphanedThreads.length})
            </button>
            ${this._showOrphaned ? html`
              <ul class="da-threads-list">
                ${orphanedThreads.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
              </ul>
            ` : nothing}
          </div>
        ` : nothing}

        ${resolvedThreads.length > 0 ? html`
          <div class="da-resolved-section">
            <button class="da-toggle-resolved" @click=${() => { this._showResolved = !this._showResolved; }}>
              ${this._showResolved ? 'Hide' : 'Show'} resolved (${resolvedThreads.length})
            </button>
            ${this._showResolved ? html`
              <ul class="da-threads-list">
                ${resolvedThreads.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
              </ul>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  renderContent() {
    if (this._isCreatingNew) {
      return this.renderNewCommentForm();
    }
    if (this._activeThreadId) {
      return this.renderThreadDetail();
    }
    return this.renderList();
  }

  renderConfirmDeleteDialog() {
    if (!this._confirmDeleteThread) return nothing;

    const action = {
      style: 'negative',
      label: 'Delete',
      click: () => this.confirmDeleteThread(),
    };

    return html`
      <da-dialog
        title="Delete thread?"
        .action=${action}
        @close=${this.cancelDeleteConfirm}>
        <p>Deleting the comment will remove the entire thread.</p>
      </da-dialog>
    `;
  }

  render() {
    return html`
      <div class="da-comments-panel">
        <p class="da-comments-title">
          <button
            class="da-comments-close-btn"
            @click=${this.handleClose}
            aria-label="Close comments pane">Comments</button>
        </p>
        ${this.renderContent()}
      </div>
      ${this.renderConfirmDeleteDialog()}
      ${renderStatusToast(this._status)}
    `;
  }
}

customElements.define('da-comments', DaComments);
