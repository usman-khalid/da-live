/* eslint-disable no-underscore-dangle */
import { expect } from '@esm-bundle/chai';
import { setNx } from '../../../../../scripts/utils.js';
import commentService from '../../../../../blocks/edit/da-comments/helpers/comment-service.js';

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
});
