/* eslint-disable no-underscore-dangle */
import { expect } from '@esm-bundle/chai';
import { setNx } from '../../../../../scripts/utils.js';
import commentService, { getRootComment } from '../../../../../blocks/edit/da-comments/helpers/index.js';

const nextFrame = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function createMockView() {
  const mockTr = {
    setMeta: () => mockTr,
    doc: { nodeAt: () => null },
  };
  return {
    state: {
      selection: { from: 0, to: 0, empty: true },
      schema: { marks: { comment: { create: () => ({}) } } },
      doc: {
        textBetween: () => '',
        nodeAt: () => null,
      },
      tr: mockTr,
    },
    dispatch: () => {},
  };
}

function createMockYMap(initial = {}) {
  const store = new Map(Object.entries(initial));
  const observers = [];
  return {
    get(key) { return store.get(key); },
    set(key, value) { store.set(key, value); observers.forEach((fn) => fn()); },
    delete(key) { store.delete(key); observers.forEach((fn) => fn()); },
    has(key) { return store.has(key); },
    forEach(fn) { store.forEach(fn); },
    observe(fn) { observers.push(fn); },
    unobserve(fn) {
      const idx = observers.indexOf(fn);
      if (idx > -1) observers.splice(idx, 1);
    },
    _store: store,
    _observers: observers,
  };
}

describe('da-comments', () => {
  let DaComments;
  let formatOrphanPreview;
  let originalView;

  before(async () => {
    setNx('/test/fixtures/nx', { hostname: 'example.com' });
    originalView = window.view;
    window.view = createMockView();

    try {
      const mod = await import('../../../../../blocks/edit/da-comments/da-comments.js');
      DaComments = mod.default;
      formatOrphanPreview = mod.formatOrphanPreview;
    } catch (e) {
      console.error('Error importing da-comments:', e);
      throw e;
    }
  });

  after(() => {
    window.view = originalView;
  });

  let el;

  beforeEach(() => {
    window.view = createMockView();
    commentService.destroy();
    const url = new URL(window.location.href);
    url.searchParams.delete('comment');
    window.history.replaceState({}, '', url.toString());
  });

  async function fixture() {
    el = new DaComments();
    document.body.appendChild(el);
    await nextFrame();
    return el;
  }

  afterEach(() => {
    if (el && el.parentElement) {
      el.remove();
    }
    el = null;
    commentService.destroy();
  });

  it('is defined', async () => {
    el = await fixture();
    expect(el).to.be.instanceOf(DaComments);
  });

  it('initializes with default state', async () => {
    el = await fixture();

    expect(el._threads).to.be.instanceOf(Map);
    expect(el._activeThreadId).to.be.null;
    expect(el._viewFilters.resolved).to.be.false;
    expect(el._viewFilters.orphaned).to.be.false;
    expect(el._formState).to.be.null;
  });

  it('emits close event when handleClose is called', async () => {
    el = await fixture();

    let closed = false;
    el.addEventListener('close', () => { closed = true; });

    el.handleClose();

    expect(closed).to.be.true;
  });

  it('emits request-open event via emitRequestOpen', async () => {
    el = await fixture();

    let requestedOpen = false;
    el.addEventListener('request-open', () => { requestedOpen = true; });

    el.emitRequestOpen();

    expect(requestedOpen).to.be.true;
  });

  it('emits count-changed event via emitCountChanged', async () => {
    el = await fixture();

    let receivedCount = null;
    el.addEventListener('count-changed', (e) => { receivedCount = e.detail; });

    el.emitCountChanged(5);

    expect(receivedCount).to.equal(5);
  });

  it('correctly identifies anonymous user', async () => {
    el = await fixture();

    el.currentUser = { id: 'anonymous-12345', name: 'Anonymous' };
    expect(el.isAnonymousUser()).to.be.true;

    el.currentUser = { id: 'user-12345', name: 'John' };
    expect(el.isAnonymousUser()).to.be.false;

    el.currentUser = null;
    expect(el.isAnonymousUser()).to.be.true;
  });

  it('correctly checks if user can edit comment', async () => {
    el = await fixture();

    const comment = { author: { id: 'user-123' } };

    el.currentUser = { id: 'user-123', name: 'John' };
    expect(el.canEditComment(comment)).to.be.true;

    el.currentUser = { id: 'user-456', name: 'Jane' };
    expect(el.canEditComment(comment)).to.be.false;

    el.currentUser = null;
    expect(el.canEditComment(comment)).to.be.false;
  });

  it('picks up threads from commentService', async () => {
    const map = createMockYMap({
      c1: {
        id: 'c1',
        threadId: 'thread-1',
        parentId: null,
        content: 'Test comment',
        author: { id: 'u1', name: 'John', email: 'john@test.com' },
        createdAt: Date.now(),
        resolved: false,
        orphaned: false,
      },
    });
    commentService.init(map);

    el = await fixture();
    await nextFrame();

    expect(el._threads.size).to.equal(1);
  });

  it('submitNewComment persists the minimal root anchor shape', async () => {
    el = await fixture();
    el.currentUser = { id: 'user-1', name: 'John Doe', email: 'john@example.com' };
    el._formState = {
      text: 'Root comment',
      selection: {
        from: 10,
        to: 18,
        selectedText: 'selected',
        isImage: false,
        isTable: false,
        imageRef: null,
        positionContext: { textBefore: 'before', textAfter: 'after' },
      },
    };

    const originalSave = commentService.save;
    let savedComment;
    commentService.save = (comment) => {
      savedComment = comment;
      return Promise.resolve();
    };

    try {
      el.submitNewComment({ preventDefault() {} });
    } finally {
      commentService.save = originalSave;
    }

    expect(savedComment.positionContext).to.deep.equal({ textBefore: 'before', textAfter: 'after' });
    expect(savedComment).to.not.have.property('anchorContext');
    expect(savedComment.anchorFrom).to.equal(10);
    expect(savedComment.anchorTo).to.equal(18);
  });

  it('handles menu toggle with event', async () => {
    el = await fixture();

    expect(el._popover).to.be.null;

    const mockEvent = { stopPropagation: () => {} };
    el.toggleMenu(mockEvent, 'comment-123');
    expect(el._popover).to.deep.equal({ type: 'menu', targetId: 'comment-123' });

    el.toggleMenu(mockEvent, 'comment-123');
    expect(el._popover).to.be.null;

    el.toggleMenu(mockEvent, 'comment-456');
    expect(el._popover).to.deep.equal({ type: 'menu', targetId: 'comment-456' });
  });

  it('handles reaction picker toggle', async () => {
    el = await fixture();

    expect(el._popover).to.be.null;

    el.toggleReactionPicker('comment-123');
    expect(el._popover).to.deep.equal({ type: 'reactions', targetId: 'comment-123' });

    el.toggleReactionPicker('comment-123');
    expect(el._popover).to.be.null;
  });

  it('handles highlight click event', async () => {
    el = await fixture();

    const threadId = 'test-thread-id';
    el.handleHighlightClick({ detail: { threadId } });

    expect(el._activeThreadId).to.equal(threadId);
  });

  it('handles outside click to close popover', async () => {
    el = await fixture();

    el._popover = { type: 'menu', targetId: 'comment-123' };
    const mockEvent = { composedPath: () => [] };
    el.handleOutsideClick(mockEvent);

    expect(el._popover).to.be.null;
  });

  it('does not close popover when clicking inside menu', async () => {
    el = await fixture();

    el._popover = { type: 'menu', targetId: 'comment-123' };
    const menuEl = { classList: { contains: (cls) => cls === 'da-comment-menu' } };
    const mockEvent = { composedPath: () => [menuEl] };
    el.handleOutsideClick(mockEvent);

    expect(el._popover).to.deep.equal({ type: 'menu', targetId: 'comment-123' });
  });

  it('formats orphan previews by trimming, collapsing whitespace, and truncating', () => {
    expect(formatOrphanPreview('  deleted   content  ', 40)).to.equal('deleted content');
    expect(formatOrphanPreview('deleted content that keeps going', 12)).to.equal('deleted cont...');
    expect(formatOrphanPreview('   ', 40)).to.equal('');
  });

  it('opens the requested thread from the URL comment param', async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('comment', 'thread-1');
    window.history.replaceState({}, '', url.toString());

    const map = createMockYMap({
      c1: {
        id: 'c1',
        threadId: 'thread-1',
        parentId: null,
        content: 'Deep-linked comment',
        author: { id: 'u1', name: 'John', email: 'john@test.com' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolved: false,
      },
    });
    commentService.init(map);

    el = await fixture();

    expect(el._activeThreadId).to.equal('thread-1');
    expect(new URL(window.location.href).searchParams.get('comment')).to.be.null;
  });

  it('saveEdit updates an existing comment through commentService', async () => {
    const map = createMockYMap({
      c1: {
        id: 'c1',
        threadId: 'thread-1',
        parentId: null,
        content: 'Before',
        author: { id: 'u1', name: 'John', email: 'john@test.com' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolved: false,
      },
    });
    commentService.init(map);

    el = await fixture();
    el._editing = { id: 'c1', text: 'After' };

    el.saveEdit({ preventDefault() {} });

    expect(commentService.getComment('c1').content).to.equal('After');
    expect(el._editing).to.be.null;
  });

  it('resolveThread and unresolveThread update the root thread state', async () => {
    const now = Date.now();
    const map = createMockYMap({
      c1: {
        id: 'c1',
        threadId: 'thread-1',
        parentId: null,
        content: 'Root',
        author: { id: 'u1', name: 'John', email: 'john@test.com' },
        createdAt: now,
        updatedAt: now,
        resolved: false,
        orphaned: true,
        orphanedAt: now,
      },
    });
    commentService.init(map);

    el = await fixture();
    el.currentUser = { id: 'u2', name: 'Reviewer' };
    el._activeThreadId = 'thread-1';

    el.resolveThread('thread-1');
    expect(getRootComment(commentService.getThread('thread-1')).resolved).to.be.true;
    expect(el._activeThreadId).to.be.null;

    el.unresolveThread('thread-1');
    const root = getRootComment(commentService.getThread('thread-1'));
    expect(root.resolved).to.be.false;
    expect(root.orphaned).to.be.undefined;
    expect(root.orphanedAt).to.be.undefined;
  });

  it('renders orphaned thread detail with the deleted content preview', async () => {
    const map = createMockYMap({
      c1: {
        id: 'c1',
        threadId: 'thread-1',
        parentId: null,
        content: 'Comment body',
        selectedText: 'Deleted content that keeps going and should be shortened for display in the badge.',
        author: { id: 'u1', name: 'John', email: 'john@test.com' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolved: false,
        orphaned: true,
      },
    });
    commentService.init(map);

    el = await fixture();
    el._activeThreadId = 'thread-1';
    el.requestUpdate();
    await el.updateComplete;

    const badge = el.shadowRoot.querySelector('.da-orphaned-badge');
    expect(badge).to.exist;
    expect(badge.textContent).to.include('Original content was deleted');
    expect(badge.textContent).to.include('Deleted content that keeps going');
    expect(badge.textContent).to.include('...');
  });
});
