import { expect } from '@esm-bundle/chai';
import { CellSelection, NodeSelection } from 'da-y-wrapper';

import { hasValidCommentSelection } from '../../../../../../../../blocks/edit/prose/plugins/comments/commentPlugin.js';
import {
  rebuildPositionCache,
  resolveLiveAnchor,
  resolveSnapshotAnchor,
  syncOrphanedThreads,
} from '../../../../../../../../blocks/edit/prose/plugins/comments/helpers/index.js';

function createTextDoc(text) {
  return {
    content: { size: text.length },
    textContent: text,
    textBetween(from, to) {
      return text.slice(from, to);
    },
    descendants(callback) {
      callback({ isText: true, text }, 0);
    },
    nodeAt() {
      return null;
    },
  };
}

function createImageDoc(images) {
  return {
    content: { size: 100 },
    textContent: '',
    textBetween() {
      return '';
    },
    descendants(callback) {
      images.forEach(({ pos, src }) => {
        callback({
          type: { name: 'image' },
          attrs: { src },
          nodeSize: 1,
        }, pos);
      });
    },
    nodeAt(pos) {
      const image = images.find((entry) => entry.pos === pos);
      return image ? { type: { name: 'image' }, attrs: { src: image.src } } : null;
    },
  };
}

function createNodeSelection(node) {
  const selection = Object.create(NodeSelection.prototype);
  Object.defineProperties(selection, {
    node: { value: node, configurable: true },
    from: { value: 1, configurable: true },
    to: { value: 2, configurable: true },
  });
  return selection;
}

function createCellSelection(cells) {
  const selection = Object.create(CellSelection.prototype);
  selection.forEachCell = (callback) => {
    cells.forEach((cell) => callback(cell));
  };
  return selection;
}

describe('commentPlugin helpers', () => {
  it('reuses a live text anchor when the current range still matches', () => {
    const state = { doc: createTextDoc('hello world') };
    const root = {
      anchorFrom: 0,
      anchorTo: 5,
      selectedText: 'hello',
      positionContext: { textBefore: '', textAfter: ' world' },
    };

    expect(resolveLiveAnchor(state, root)).to.deep.equal({ from: 0, to: 5 });
  });

  it('does not trust a live text anchor when only boundary context still matches', () => {
    const state = { doc: createTextDoc('hello brave world') };
    const root = {
      anchorFrom: 6,
      anchorTo: 11,
      selectedText: 'world',
      positionContext: { textBefore: 'hello ', textAfter: ' world' },
    };

    expect(resolveLiveAnchor(state, root)).to.equal(null);
  });

  it('re-resolves a snapshot anchor when the mapped range no longer exists', () => {
    const state = { doc: createTextDoc('one two one three') };
    const root = {
      selectedText: 'one',
      positionContext: { textBefore: 'two ', textAfter: ' three' },
    };

    expect(resolveSnapshotAnchor(state, root)).to.deep.equal({ from: 8, to: 11 });
  });

  it('rebuilds the cache by keeping valid ranges and re-resolving invalid ranges', () => {
    const state = { doc: createTextDoc('alpha beta gamma') };
    const threads = new Map([
      ['existing', [{ threadId: 'existing', parentId: null, selectedText: 'beta' }]],
      ['moved', [{
        threadId: 'moved',
        parentId: null,
        selectedText: 'gamma',
        positionContext: { textBefore: 'alpha beta ', textAfter: '' },
      }]],
    ]);
    const previousCache = new Map([
      ['existing', { from: 6, to: 10 }],
      ['moved', { from: 20, to: 19 }],
      ['stale', { from: 1, to: 4 }],
    ]);

    const nextCache = rebuildPositionCache(state, threads, previousCache);

    expect(Array.from(nextCache.entries())).to.deep.equal([
      ['existing', { from: 6, to: 10 }],
      ['moved', { from: 11, to: 16 }],
    ]);
  });

  it('restores image anchors by matching the stored image reference', () => {
    const state = { doc: createImageDoc([{ pos: 7, src: '/media/example.png' }]) };
    const root = {
      isImage: true,
      anchorFrom: 0,
      anchorTo: 1,
      imageRef: 'example.png',
    };

    expect(resolveLiveAnchor(state, root)).to.deep.equal({ from: 7, to: 8 });
  });

  it('marks missing threads orphaned and clears orphaned threads when they reattach', async () => {
    const store = {
      initialized: true,
      threads: new Map([
        ['missing', [{ threadId: 'missing', parentId: null, resolved: false, orphaned: false }]],
        ['restored', [{ threadId: 'restored', parentId: null, resolved: false, orphaned: true }]],
      ]),
      orphanedCalls: [],
      restoredCalls: [],
      async markThreadOrphaned(threadId, orphanedAt) {
        this.orphanedCalls.push({ threadId, orphanedAt });
      },
      async clearThreadOrphaned(threadId) {
        this.restoredCalls.push(threadId);
      },
    };

    const orphanedIds = await syncOrphanedThreads(store, new Map([
      ['restored', { from: 2, to: 5 }],
    ]), 1234);

    expect(orphanedIds).to.deep.equal(['missing']);
    expect(store.orphanedCalls).to.deep.equal([{ threadId: 'missing', orphanedAt: 1234 }]);
    expect(store.restoredCalls).to.deep.equal(['restored']);
  });
});

describe('commentPlugin selection checks', () => {
  it('accepts non-empty text selections and rejects collapsed text selections', () => {
    const state = {
      selection: { from: 1, to: 5 },
      doc: createTextDoc('alpha beta'),
    };
    const collapsedState = {
      selection: { from: 2, to: 2 },
      doc: createTextDoc('alpha beta'),
    };

    expect(hasValidCommentSelection(state)).to.be.true;
    expect(hasValidCommentSelection(collapsedState)).to.be.false;
  });

  it('accepts image node selections', () => {
    const state = {
      selection: createNodeSelection({ type: { name: 'image' } }),
      doc: createTextDoc(''),
    };

    expect(hasValidCommentSelection(state)).to.be.true;
  });

  it('accepts table selections with text or images and rejects empty tables', () => {
    const imageCell = {
      textContent: '',
      descendants(callback) {
        callback({ type: { name: 'image' } }, 0);
      },
    };
    const emptyCell = {
      textContent: '',
      descendants() {},
    };

    const tableNode = {
      type: { name: 'table' },
      textContent: '',
      descendants(callback) {
        callback({ type: { name: 'image' } }, 0);
      },
    };

    expect(hasValidCommentSelection({
      selection: createNodeSelection(tableNode),
      doc: createTextDoc(''),
    })).to.be.true;

    expect(hasValidCommentSelection({
      selection: createCellSelection([imageCell]),
      doc: createTextDoc(''),
    })).to.be.true;

    expect(hasValidCommentSelection({
      selection: createCellSelection([emptyCell]),
      doc: createTextDoc(''),
    })).to.be.false;
  });
});
