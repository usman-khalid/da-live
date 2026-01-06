/* eslint-disable no-underscore-dangle */
import { expect } from '@esm-bundle/chai';
import { setNx } from '../../../../../scripts/utils.js';

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

describe('da-comments', () => {
  let DaComments;
  let originalView;

  before(async () => {
    setNx('/test/fixtures/nx', { hostname: 'example.com' });
    originalView = window.view;
    window.view = createMockView();

    try {
      const mod = await import('../../../../../blocks/edit/da-comments/da-comments.js');
      DaComments = mod.default;
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
  });

  it('is defined', async () => {
    el = await fixture();
    expect(el).to.be.instanceOf(DaComments);
  });

  it('initializes with default state', async () => {
    el = await fixture();

    expect(el._threads).to.be.instanceOf(Map);
    expect(el._activeThreadId).to.be.null;
    expect(el._showResolved).to.be.false;
    expect(el._isCreatingNew).to.be.false;
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

  it('updates threads when commentsMap changes', async () => {
    el = await fixture();

    const mockCommentsMap = new Map();
    mockCommentsMap.set('c1', {
      id: 'c1',
      threadId: 'thread-1',
      parentId: null,
      content: 'Test comment',
      author: { id: 'u1', name: 'John', email: 'john@test.com' },
      createdAt: Date.now(),
      resolved: false,
      orphaned: false,
    });
    mockCommentsMap.observe = () => {};
    mockCommentsMap.daCommentsObserverSet = false;

    el.commentsMap = mockCommentsMap;
    await nextFrame();

    expect(el._threads.size).to.equal(1);
  });

  it('calculates comment count correctly', async () => {
    el = await fixture();

    el._threads = new Map();
    el._threads.set('thread-1', [
      { id: 'c1', parentId: null, resolved: false, orphaned: false },
    ]);
    el._threads.set('thread-2', [
      { id: 'c2', parentId: null, resolved: true, orphaned: false },
    ]);
    el._threads.set('thread-3', [
      { id: 'c3', parentId: null, resolved: false, orphaned: true },
    ]);
    el._threads.set('thread-4', [
      { id: 'c4', parentId: null, resolved: false, orphaned: false },
    ]);

    expect(el.commentCount).to.equal(2);
  });

  it('handles menu toggle with event', async () => {
    el = await fixture();

    expect(el._menuOpen).to.be.null;

    const mockEvent = { stopPropagation: () => {} };
    el.toggleMenu(mockEvent, 'comment-123');
    expect(el._menuOpen).to.equal('comment-123');

    el.toggleMenu(mockEvent, 'comment-123');
    expect(el._menuOpen).to.be.null;

    el.toggleMenu(mockEvent, 'comment-456');
    expect(el._menuOpen).to.equal('comment-456');
  });

  it('handles reaction picker toggle', async () => {
    el = await fixture();

    expect(el._reactionPickerCommentId).to.be.null;

    el.toggleReactionPicker('comment-123');
    expect(el._reactionPickerCommentId).to.equal('comment-123');

    el.toggleReactionPicker('comment-123');
    expect(el._reactionPickerCommentId).to.be.null;
  });

  it('toggles resolved comments visibility via property', async () => {
    el = await fixture();

    expect(el._showResolved).to.be.false;

    el._showResolved = true;
    expect(el._showResolved).to.be.true;

    el._showResolved = false;
    expect(el._showResolved).to.be.false;
  });

  it('toggles orphaned comments visibility via property', async () => {
    el = await fixture();

    expect(el._showOrphaned).to.be.false;

    el._showOrphaned = true;
    expect(el._showOrphaned).to.be.true;

    el._showOrphaned = false;
    expect(el._showOrphaned).to.be.false;
  });

  it('handles comment clicked event', async () => {
    el = await fixture();

    const threadId = 'test-thread-id';
    el.handleCommentClicked({ detail: { threadId } });

    expect(el._activeThreadId).to.equal(threadId);
  });

  it('handles outside click to close menu', async () => {
    el = await fixture();

    el._menuOpen = 'comment-123';
    const mockEvent = { composedPath: () => [] };
    el.handleOutsideClick(mockEvent);

    expect(el._menuOpen).to.be.null;
  });

  it('does not close menu when clicking inside menu', async () => {
    el = await fixture();

    el._menuOpen = 'comment-123';
    const menuEl = { classList: { contains: (cls) => cls === 'da-comment-menu' } };
    const mockEvent = { composedPath: () => [menuEl] };
    el.handleOutsideClick(mockEvent);

    expect(el._menuOpen).to.equal('comment-123');
  });
});
