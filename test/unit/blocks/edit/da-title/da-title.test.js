import { expect } from '@esm-bundle/chai';
import { setNx } from '../../../../../scripts/utils.js';
import DaTitle from '../../../../../blocks/edit/da-title/da-title.js';

const nextFrame = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const waitFor = async (predicate, retries = 20) => {
  for (let i = 0; i < retries; i += 1) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await nextFrame();
  }
  return false;
};

function createDetails(view, fullpath = '/org/repo/path') {
  return {
    view,
    fullpath,
    sourceUrl: 'https://da.live/config/org/repo',
    parent: '/org/repo',
    parentName: 'repo',
    name: 'path',
  };
}

describe('da-title', () => {
  let element;

  before(() => {
    setNx('/test/fixtures/nx', { hostname: 'example.com' });
  });

  afterEach(() => {
    element?.remove();
    element = null;
  });

  it('detects .da docs and save-only views correctly', () => {
    element = new DaTitle();

    element.details = createDetails('edit', '/org/repo/.da/config.json');
    expect(element.getInitialActions()).to.deep.equal([]);

    element.details = createDetails('sheet', '/org/repo/data');
    expect(element.getInitialActions()).to.deep.equal(['save']);

    element.details = createDetails('config', '/org/repo');
    expect(element.getInitialActions()).to.deep.equal(['save']);
  });

  it('renders stale config modal when remote config changes', async () => {
    element = new DaTitle();
    element.details = createDetails('config');
    document.body.append(element);

    const originalFetch = window.fetch;
    let currentPayload = { value: 'old' };
    window.fetch = async (url, opts) => {
      if (url === element.details.sourceUrl) {
        return new Response(JSON.stringify(currentPayload), { status: 200 });
      }
      return originalFetch(url, opts);
    };

    try {
      await element.cacheConfigData();
      currentPayload = { value: 'new' };
      await element.checkConfigChanges();
      const rendered = await waitFor(() => !!element.shadowRoot.querySelector('da-dialog'));
      expect(rendered).to.equal(true);

      const dialog = element.shadowRoot.querySelector('da-dialog');
      expect(dialog).to.exist;
      expect(dialog.getAttribute('title')).to.equal('Config Updated');

      const rightButtons = element.shadowRoot.querySelectorAll('sl-button[slot="footer-right"]');
      expect(rightButtons.length).to.equal(2);
      expect(rightButtons[0].textContent.trim()).to.equal('Ignore');
      expect(rightButtons[1].textContent.trim()).to.equal('Refresh');
    } finally {
      element.clearConfigPolling();
      window.fetch = originalFetch;
    }
  });

  it('does not show stale modal again after ignore', async () => {
    element = new DaTitle();
    element.details = createDetails('config');

    const originalFetch = window.fetch;
    let staleDialogCalls = 0;
    let currentPayload = { value: 'old' };
    window.fetch = async (url, opts) => {
      if (url === element.details.sourceUrl) {
        return new Response(JSON.stringify(currentPayload), { status: 200 });
      }
      return originalFetch(url, opts);
    };
    element.showConfigStaleDialog = () => { staleDialogCalls += 1; };

    try {
      await element.cacheConfigData();
      currentPayload = { value: 'new' };

      await element.checkConfigChanges();
      expect(staleDialogCalls).to.equal(1);

      element.handleConfigIgnore();
      await element.checkConfigChanges();
      expect(staleDialogCalls).to.equal(1);
    } finally {
      element.clearConfigPolling();
      window.fetch = originalFetch;
    }
  });
});
