/* eslint-disable no-underscore-dangle */
import { expect } from '@esm-bundle/chai';

// This is needed to make a dynamic import work that is indirectly referenced
// from da-editor.js
const { setNx } = await import('../../../../../scripts/utils.js');
setNx('/bheuaark/', { hostname: 'localhost' });

const { default: DaContent } = await import('../../../../../blocks/edit/da-content/da-content.js');

describe('da-content', () => {
  it('Test wsprovider disconnectedcallback', async () => {
    const ed = new DaContent();

    const called = [];
    const mockWSProvider = { disconnect: () => called.push('disconnect') };

    ed.wsProvider = mockWSProvider;
    ed.disconnectWebsocket();
    expect(ed.wsProvider).to.be.undefined;
    expect(called).to.deep.equal(['disconnect']);
  });

  it('initializes with default state', () => {
    const ed = new DaContent();

    expect(ed._commentCount).to.equal(0);
  });

  it('toggles pane correctly', () => {
    const ed = new DaContent();

    ed.togglePane({ detail: 'preview' });
    expect(ed._showPane).to.equal('preview');

    ed.togglePane({ detail: 'versions' });
    expect(ed._showPane).to.equal('versions');

    ed.togglePane({ detail: 'comments' });
    expect(ed._showPane).to.equal('comments');
  });
});
