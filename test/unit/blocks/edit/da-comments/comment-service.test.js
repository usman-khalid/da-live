import { expect } from '@esm-bundle/chai';
import commentService, { getRootComment } from '../../../../../blocks/edit/da-comments/helpers/index.js';

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
    observerCount() { return observers.length; },
    unobserve(fn) {
      const idx = observers.indexOf(fn);
      if (idx > -1) observers.splice(idx, 1);
    },
  };
}

function makeComment(overrides = {}) {
  const id = overrides.id || `c-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    threadId: overrides.threadId || id,
    parentId: overrides.parentId || null,
    author: overrides.author || { id: 'u1', name: 'Test', email: 'test@example.com' },
    content: overrides.content || 'Test comment',
    createdAt: overrides.createdAt || Date.now(),
    updatedAt: overrides.updatedAt || Date.now(),
    resolved: overrides.resolved || false,
    resolvedBy: overrides.resolvedBy || null,
    resolvedAt: overrides.resolvedAt || null,
    selectedText: overrides.selectedText || 'text',
    isImage: overrides.isImage || false,
    positionContext: overrides.positionContext || null,
    ...overrides,
  };
}

describe('CommentService', () => {
  let originalFetch;
  let originalAdobeIMS;

  beforeEach(() => {
    originalFetch = window.fetch;
    originalAdobeIMS = window.adobeIMS;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    window.adobeIMS = originalAdobeIMS;
    commentService.destroy();
  });

  describe('init / destroy', () => {
    it('starts uninitialized', () => {
      expect(commentService.initialized).to.be.false;
      expect(commentService.threads.size).to.equal(0);
    });

    it('initializes with a Y.Map', () => {
      const map = createMockYMap();
      commentService.init(map);
      expect(commentService.initialized).to.be.true;
    });

    it('syncs existing map data on init', () => {
      const c = makeComment({ id: 'c1', threadId: 't1' });
      const map = createMockYMap({ c1: c });
      commentService.init(map);
      expect(commentService.threads.size).to.equal(1);
      expect(commentService.threads.get('t1')).to.have.length(1);
    });

    it('cleans up on destroy', () => {
      const map = createMockYMap();
      commentService.init(map);
      commentService.destroy();
      expect(commentService.initialized).to.be.false;
      expect(commentService.threads.size).to.equal(0);
      expect(map.observerCount()).to.equal(0);
    });

    it('re-initializes cleanly', () => {
      const map1 = createMockYMap();
      commentService.init(map1);
      const map2 = createMockYMap({ c1: makeComment({ id: 'c1', threadId: 't1' }) });
      commentService.init(map2);
      expect(commentService.threads.size).to.equal(1);
      expect(map1.observerCount()).to.equal(0);
    });
  });

  describe('readOnly mode', () => {
    it('defaults to read-write', () => {
      const map = createMockYMap();
      commentService.init(map);
      expect(commentService.readOnly).to.be.false;
    });

    it('can be initialized as read-only', () => {
      const map = createMockYMap();
      commentService.init(map, { readOnly: true, collabOrigin: 'http://localhost:8787', docName: 'doc' });
      expect(commentService.readOnly).to.be.true;
    });

    it('save() emits a compact REST doc path without .html', async () => {
      const map = createMockYMap();
      const comment = makeComment({ id: 'c1', threadId: 't1' });
      const calls = [];
      window.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true };
      };
      window.adobeIMS = null;

      commentService.init(map, {
        readOnly: true,
        collabOrigin: 'http://localhost:4711',
        docName: 'http://localhost:8787/source/org/site/doc.html',
      });

      await commentService.save(comment);

      expect(calls).to.have.length(1);
      expect(calls[0].url).to.equal('http://localhost:4711/api/v1/comment?doc=%2Forg%2Fsite%2Fdoc');
      expect(calls[0].opts.method).to.equal('POST');
      expect(JSON.parse(calls[0].opts.body)).to.deep.equal(comment);
    });

    it('remove() uses the same compact REST doc path', async () => {
      const map = createMockYMap();
      const calls = [];
      window.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true };
      };
      window.adobeIMS = null;

      commentService.init(map, {
        readOnly: true,
        collabOrigin: 'http://localhost:4711',
        docName: 'http://localhost:8787/source/org/site/doc.html',
      });

      await commentService.remove('c1');

      expect(calls).to.have.length(1);
      expect(calls[0].url).to.equal('http://localhost:4711/api/v1/comment?doc=%2Forg%2Fsite%2Fdoc');
      expect(calls[0].opts.method).to.equal('DELETE');
    });
  });

  describe('CRUD — read-write mode', () => {
    let map;

    beforeEach(() => {
      map = createMockYMap();
      commentService.init(map);
    });

    it('save() adds a comment to the map', async () => {
      const c = makeComment({ id: 'c1', threadId: 't1' });
      await commentService.save(c);
      expect(map.get('c1')).to.deep.equal(c);
    });

    it('remove() deletes a comment from the map', async () => {
      const c = makeComment({ id: 'c1', threadId: 't1' });
      map.set('c1', c);
      await commentService.remove('c1');
      expect(map.has('c1')).to.be.false;
    });

    it('removeThread() deletes all comments in a thread', async () => {
      const root = makeComment({ id: 'c1', threadId: 't1' });
      const reply = makeComment({ id: 'c2', threadId: 't1', parentId: 'c1', createdAt: root.createdAt + 1 });
      map.set('c1', root);
      map.set('c2', reply);

      await commentService.removeThread('t1');
      expect(map.has('c1')).to.be.false;
      expect(map.has('c2')).to.be.false;
    });

    it('updateComment() saves the updater result', async () => {
      map.set('c1', makeComment({ id: 'c1', threadId: 't1', content: 'before' }));

      const updated = await commentService.updateComment('c1', (comment) => ({
        ...comment,
        content: 'after',
      }));

      expect(updated.content).to.equal('after');
      expect(map.get('c1').content).to.equal('after');
    });

    it('markThreadOrphaned() and clearThreadOrphaned() round-trip orphan state on the root', async () => {
      map.set('c1', makeComment({ id: 'c1', threadId: 't1', orphaned: false }));

      await commentService.markThreadOrphaned('t1', 1234);
      expect(map.get('c1').orphaned).to.be.true;
      expect(map.get('c1').orphanedAt).to.equal(1234);

      await commentService.clearThreadOrphaned('t1');
      expect(map.get('c1').orphaned).to.be.undefined;
      expect(map.get('c1').orphanedAt).to.be.undefined;
    });
  });

  describe('getters', () => {
    it('getComment() returns a comment by id', () => {
      const c = makeComment({ id: 'c1' });
      const map = createMockYMap({ c1: c });
      commentService.init(map);
      expect(commentService.getComment('c1')).to.deep.equal(c);
    });

    it('getComment() returns null for missing id', () => {
      commentService.init(createMockYMap());
      expect(commentService.getComment('nope')).to.be.null;
    });

    it('getThread() returns comments for a thread', () => {
      const c = makeComment({ id: 'c1', threadId: 't1' });
      commentService.init(createMockYMap({ c1: c }));
      const thread = commentService.getThread('t1');
      expect(thread).to.have.length(1);
      expect(thread[0].id).to.equal('c1');
    });

    it('getRootComment() returns the root of a thread', () => {
      const root = makeComment({ id: 'c1', threadId: 't1', parentId: null });
      const reply = makeComment({ id: 'c2', threadId: 't1', parentId: 'c1', createdAt: root.createdAt + 1 });
      commentService.init(createMockYMap({ c1: root, c2: reply }));
      const r = getRootComment(commentService.getThread('t1'));
      expect(r.id).to.equal('c1');
    });

    it('activeCount only counts unresolved, non-orphaned threads', () => {
      const active = makeComment({ id: 'c1', threadId: 't1', resolved: false });
      const resolved = makeComment({ id: 'c2', threadId: 't2', resolved: true });
      const orphaned = makeComment({ id: 'c3', threadId: 't3', resolved: false, orphaned: true });
      commentService.init(createMockYMap({ c1: active, c2: resolved, c3: orphaned }));
      expect(commentService.activeCount).to.equal(1);
    });
  });

  describe('change events', () => {
    it('dispatches change when Y.Map is modified externally', () => {
      const map = createMockYMap();
      commentService.init(map);

      let fired = false;
      commentService.addEventListener('change', () => { fired = true; });

      map.set('c1', makeComment({ id: 'c1', threadId: 't1' }));
      expect(fired).to.be.true;
    });

    it('updates threads on change', () => {
      const map = createMockYMap();
      commentService.init(map);
      expect(commentService.threads.size).to.equal(0);

      map.set('c1', makeComment({ id: 'c1', threadId: 't1' }));
      expect(commentService.threads.size).to.equal(1);
    });
  });
});
