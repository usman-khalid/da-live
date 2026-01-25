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
  wasEdited,
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
    _viewFilters: { state: true }, // { resolved, orphaned }
    _formState: { state: true }, // { mode: 'new'|'reply'|null, selection, text, replyTo }
    _popover: { state: true }, // { type: 'menu'|'reactions'|'delete', targetId } | null
    _editing: { state: true }, // { id, text } | null
    _status: { state: true },
  };

  get canAddComment() {
    return window.view ? hasValidCommentSelection(window.view.state) : false;
  }

  constructor() {
    super();
    this._threads = new Map();
    this._activeThreadId = null;
    this._viewFilters = { resolved: false, orphaned: false };
    this._formState = null;
    this._popover = null;
    this._editing = null;
    this._pendingScrollToComment = null;
    this.handleCommentFocus = this.handleCommentFocus.bind(this);
    this.handleOrphanedComments = this.handleOrphanedComments.bind(this);
    this.handleOutsideClick = this.handleOutsideClick.bind(this);
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.handleCommentAddRequest = this.handleCommentAddRequest.bind(this);
  }

  resetFormState() {
    this._formState = null;
    this._popover = null;
    this._editing = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sheet, toastSheet];
    window.addEventListener('da-comment-focus', this.handleCommentFocus);
    window.addEventListener('da-comments-orphaned', this.handleOrphanedComments);
    window.addEventListener('da-selection-change', this.handleSelectionChange);
    window.addEventListener('da-comment-add', this.handleCommentAddRequest);
    document.addEventListener('click', this.handleOutsideClick);
    import('../../shared/da-dialog/da-dialog.js');
    this.checkUrlForComment();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('da-comment-focus', this.handleCommentFocus);
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
    if (!this._popover) return;

    const path = event.composedPath();
    const isInside = path.some((el) => el.classList?.contains('da-comment-menu')
      || el.classList?.contains('da-reactions')
      || el.classList?.contains('da-reaction-picker'));

    if (!isInside) {
      this._popover = null;
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
   * Handle selection change events from plugin
   */
  handleSelectionChange() {
    // Cancel new comment creation if selection is lost
    if (!this.canAddComment && this._formState?.mode === 'new') {
      this.cancelNewComment();
    }
    this.requestUpdate();
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
    if (this._formState?.mode === 'new') {
      this.cancelNewComment();
    }
    clearPendingCommentRange();
    const opts = { bubbles: true, composed: true };
    const event = new CustomEvent('close', opts);
    this.dispatchEvent(event);
  }

  handleCommentFocus(event) {
    const { threadId } = event.detail;
    if (this._activeThreadId === threadId) return;

    this._activeThreadId = threadId;
    this.resetFormState();

    if (threadId) {
      this.emitRequestOpen();
      requestAnimationFrame(() => {
        const threadDetail = this.shadowRoot?.querySelector('.da-thread-detail');
        if (threadDetail) {
          threadDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
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

    if (changedProps.has('_formState') && this._formState?.mode === 'new') {
      this.focusCommentTextarea();
    }

    if (changedProps.has('open') && this.open && !changedProps.get('open')) {
      if (this.canAddComment && !this._formState && !this._activeThreadId) {
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

  /**
   * Open a comment thread directly from URL param
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

    let count = 0;
    this._threads.forEach((comments) => {
      const root = getRootComment(comments);
      if (root && !root.resolved && !root.orphaned) {
        count += 1;
      }
    });
    this.emitCountChanged(count);

    this.requestUpdate();
  }

  selectThread(threadId) {
    this._activeThreadId = threadId;
    this.resetFormState();
    setActiveThread(threadId);
    this._pendingScrollToComment = threadId;
  }

  backToList() {
    this._activeThreadId = null;
    this.resetFormState();
    setActiveThread(null);
  }

  handleTextareaInput(event) {
    if (!this._formState) return;
    this._formState = { ...this._formState, text: event.target.value };
  }

  handleEditInput(event) {
    if (!this._editing) return;
    this._editing = { ...this._editing, text: event.target.value };
  }

  toggleReactionPicker(commentId) {
    const isOpen = this._popover?.type === 'reactions' && this._popover.targetId === commentId;
    this._popover = isOpen ? null : { type: 'reactions', targetId: commentId };
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
    this._popover = null;
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

    this._formState = {
      mode: 'new',
      selection: { from, to, selectedText, isImage, positionContext },
      text: '',
      replyTo: null,
    };
    this._activeThreadId = null;
    setActiveThread(null);

    setPendingCommentRange({ from, to, isImage });
  }

  cancelNewComment() {
    this.resetFormState();
    clearPendingCommentRange();
  }

  submitNewComment(event) {
    event.preventDefault();
    const content = this._formState?.text?.trim();

    if (!content || !this._formState?.selection) return;

    const commentId = crypto.randomUUID();
    const { selectedText, isImage, positionContext } = this._formState.selection;

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
    const content = this._formState?.text?.trim();

    if (!content || !this._formState?.replyTo) return;

    const rootComment = this._threads.get(this._activeThreadId)?.[0];
    if (rootComment) {
      const reply = createReply(rootComment, this.currentUser, content);
      this.commentsMap.set(reply.id, reply);
    }

    this._formState = null;
  }

  toggleMenu(event, commentId) {
    event.stopPropagation();
    const isOpen = this._popover?.type === 'menu' && this._popover.targetId === commentId;
    this._popover = isOpen ? null : { type: 'menu', targetId: commentId };
  }

  startEdit(commentId) {
    const comment = this.commentsMap.get(commentId);
    if (comment) {
      this._editing = { id: commentId, text: comment.content };
      this._popover = null;
    }
  }

  saveEdit(event) {
    event.preventDefault();
    const content = this._editing?.text?.trim();
    if (!content || !this._editing?.id) return;

    const comment = this.commentsMap.get(this._editing.id);
    if (comment) {
      this.commentsMap.set(this._editing.id, {
        ...comment,
        content,
        updatedAt: Date.now(),
      });
    }

    this._editing = null;
  }

  cancelEdit() {
    this._editing = null;
  }

  deleteComment(commentId) {
    this._popover = null;

    const comments = this._threads.get(this._activeThreadId);
    if (!comments) return;

    const rootComment = getRootComment(comments);
    const isRoot = rootComment?.id === commentId;

    if (isRoot && comments.length > 1) {
      this._popover = { type: 'delete', threadId: this._activeThreadId };
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
    if (this._popover?.type !== 'delete') return;

    const { threadId } = this._popover;
    const comments = this._threads.get(threadId);
    if (!comments) {
      this._popover = null;
      return;
    }

    removeCommentMark(threadId);
    comments.forEach((c) => {
      this.commentsMap.delete(c.id);
    });

    this._activeThreadId = null;
    this._popover = null;
    setActiveThread(null);
  }

  cancelDeleteConfirm() {
    this._popover = null;
  }

  resolveThread(threadId) {
    const comments = this._threads.get(threadId);
    if (!comments) return;

    const rootComment = getRootComment(comments);
    const resolved = resolveComment(rootComment, this.currentUser);
    this.commentsMap.set(rootComment.id, resolved);

    removeCommentMark(threadId);

    this._activeThreadId = null;
    this.resetFormState();
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
    this.resetFormState();
    setActiveThread(null);
  }

  setStatus(text, description, type = 'info') {
    this._status = text ? { type, text, description } : null;
  }

  copyCommentLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('comment', this._activeThreadId);
    navigator.clipboard.writeText(url.toString());
    this._popover = null;

    this.setStatus('Copied', 'The link was copied to the clipboard.');
    setTimeout(() => { this.setStatus(); }, 3000);
  }

  categorizeThreads() {
    const active = [];
    const orphaned = [];
    const resolved = [];

    for (const [threadId, comments] of this._threads.entries()) {
      const root = getRootComment(comments);
      const entry = [threadId, comments, root];
      if (root.resolved) resolved.push(entry);
      else if (root.orphaned) orphaned.push(entry);
      else active.push(entry);
    }

    const sortFn = (a, b) => b[2].createdAt - a[2].createdAt;
    return {
      active: active.sort(sortFn),
      orphaned: orphaned.sort(sortFn),
      resolved: resolved.sort(sortFn),
    };
  }

  getStatusClass(rootComment) {
    if (rootComment.resolved) return 'resolved';
    if (rootComment.orphaned) return 'orphaned';
    return '';
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
    const statusClass = this.getStatusClass(rootComment);

    return html`
      <li class="da-thread-preview ${statusClass}"
          @click=${() => this.selectThread(threadId)}>
        <div class="da-thread-preview-header">
          ${this.renderAvatar(rootComment.author)}
          <div class="da-thread-preview-meta">
            <span class="da-thread-preview-author">${rootComment.author.name}</span>
            <span class="da-thread-preview-time" title="${formatFullTimestamp(rootComment.createdAt)}">
              ${formatTimestamp(rootComment.createdAt)}${wasEdited(rootComment) ? html`<span class="da-edited-indicator" title="Edited ${formatFullTimestamp(rootComment.updatedAt)}"> · Edited</span>` : nothing}
            </span>
          </div>
          ${rootComment.resolved ? html`<span class="da-resolved-tag">Resolved</span>` : nothing}
          ${rootComment.orphaned ? html`<span class="da-orphaned-tag">Detached</span>` : nothing}
        </div>
        <p class="da-thread-preview-content">${rootComment.content}</p>
        ${replyCount > 0 ? html`
          <span class="da-thread-preview-replies">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
        ` : nothing}
      </li>
    `;
  }

  renderComment(comment, isRoot = false, isResolved = false) {
    const isEditing = this._editing?.id === comment.id;

    if (isEditing) {
      return html`
        <div class="da-comment ${isRoot ? 'da-comment-root' : 'da-comment-reply'}">
          <div class="da-comment-header">
            ${this.renderAvatar(comment.author)}
            <div class="da-comment-meta">
              <span class="da-comment-author">${comment.author.name}</span>
              <span class="da-comment-time" title="${formatFullTimestamp(comment.createdAt)}">
                ${formatTimestamp(comment.createdAt)}${wasEdited(comment) ? html`<span class="da-edited-indicator" title="Edited ${formatFullTimestamp(comment.updatedAt)}"> · Edited</span>` : nothing}
              </span>
            </div>
          </div>
          <form @submit=${this.saveEdit} class="da-comment-form da-edit-form">
            <textarea
              .value=${this._editing?.text || ''}
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
                ?disabled=${!this._editing?.text?.trim()}
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
            <span class="da-comment-time" title="${formatFullTimestamp(comment.createdAt)}">
              ${formatTimestamp(comment.createdAt)}${wasEdited(comment) ? html`<span class="da-edited-indicator" title="Edited ${formatFullTimestamp(comment.updatedAt)}"> · Edited</span>` : nothing}
            </span>
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
    const showPicker = this._popover?.type === 'reactions' && this._popover.targetId === comment.id;
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

    const isOpen = this._popover?.type === 'menu' && this._popover.targetId === comment.id;

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
          .value=${isReplying ? (this._formState?.text || '') : ''}
          @input=${this.handleTextareaInput}
          @focus=${() => {
            this._formState = { mode: 'reply', selection: null, text: '', replyTo: rootComment.id };
          }}
          @keydown=${(e) => {
            if (e.key === 'Escape') {
              this._formState = null;
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
              this._formState = null;
            }}>Cancel</button>
            <button
              type="submit"
              class="da-btn-submit"
              ?disabled=${!this._formState?.text?.trim()}
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
              .value=${this._formState?.text || ''}
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
                ?disabled=${!this._formState?.text?.trim()}
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
    const isReplying = this._formState?.mode === 'reply' && this._formState?.replyTo === rootComment.id;
    const cardClass = this.getStatusClass(rootComment);

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
    const { active, orphaned, resolved } = this.categorizeThreads();

    const canAdd = this.canAddComment && !this.isAnonymousUser();
    let buttonTitle = 'Select text to comment';
    if (this.isAnonymousUser()) {
      buttonTitle = 'Sign in to add comments';
    } else if (this.canAddComment) {
      buttonTitle = 'Add comment';
    }

    return html`
      <div class="da-comments-list">
        <button
          class="da-add-comment-btn"
          @click=${this.startAddComment}
          ?disabled=${!canAdd}
          title=${buttonTitle}
        >
          <span class="da-icon da-icon-add"></span>
          Add comment
        </button>

        ${active.length > 0 ? html`
          <ul class="da-threads-list">
            ${active.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
          </ul>
        ` : html`
          <p class="da-no-comments">No comments yet</p>
        `}

        ${orphaned.length > 0 ? html`
          <div class="da-orphaned-section">
            <button class="da-toggle-orphaned" @click=${() => { this._viewFilters = { ...this._viewFilters, orphaned: !this._viewFilters.orphaned }; }}>
              ${this._viewFilters.orphaned ? 'Hide' : 'Show'} detached (${orphaned.length})
            </button>
            ${this._viewFilters.orphaned ? html`
              <ul class="da-threads-list">
                ${orphaned.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
              </ul>
            ` : nothing}
          </div>
        ` : nothing}

        ${resolved.length > 0 ? html`
          <div class="da-resolved-section">
            <button class="da-toggle-resolved" @click=${() => { this._viewFilters = { ...this._viewFilters, resolved: !this._viewFilters.resolved }; }}>
              ${this._viewFilters.resolved ? 'Hide' : 'Show'} resolved (${resolved.length})
            </button>
            ${this._viewFilters.resolved ? html`
              <ul class="da-threads-list">
                ${resolved.map(([threadId, comments]) => this.renderThreadPreview(threadId, comments))}
              </ul>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  renderContent() {
    if (this._formState?.mode === 'new') {
      return this.renderNewCommentForm();
    }
    if (this._activeThreadId) {
      return this.renderThreadDetail();
    }
    return this.renderList();
  }

  renderConfirmDeleteDialog() {
    if (this._popover?.type !== 'delete') return nothing;

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
