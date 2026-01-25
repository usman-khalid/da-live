import { LitElement, html, nothing } from 'da-lit';
import {
  requestRole,
  saveToDa,
  saveToAem,
  saveDaConfig,
  saveDaVersion,
  getCdnConfig,
} from '../utils/helpers.js';
import { DA_ORIGIN } from '../../shared/constants.js';
import { daFetch, getFirstSheet } from '../../shared/utils.js';
import inlinesvg from '../../shared/inlinesvg.js';
import getSheet from '../../shared/sheet.js';

const sheet = await getSheet('/blocks/edit/da-title/da-title.css');

const ICONS = [
  '/blocks/edit/img/Smock_Cloud_18_N.svg',
  '/blocks/edit/img/Smock_CloudDisconnected_18_N.svg',
  '/blocks/edit/img/Smock_CloudError_18_N.svg',
  '/blocks/edit/img/cloud_refresh.svg',
];

const CLOUD_ICONS = {
  connected: 'spectrum-Cloud-connected',
  disconnected: 'spectrum-Cloud-offline',
  offline: 'spectrum-Cloud-offline',
  connecting: 'cloud_refresh',
  error: 'spectrum-Cloud-error',
};

export default class DaTitle extends LitElement {
  static properties = {
    details: { attribute: false },
    permissions: { attribute: false },
    collabStatus: { attribute: false },
    collabUsers: { attribute: false },
    previewPrefix: { attribute: false },
    livePrefix: { attribute: false },
    hasChanges: { attribute: false },
    _savingDisabled: { state: true },
    _actionsVis: { state: true },
    _status: { state: true },
    _fixedActions: { state: true },
    _dialog: { state: true },
  };

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sheet];
    this._actionsVis = this.getInitialActions();
    this.hasChanges = false;
    this._savingDisabled = false;
    this._isStaleIgnored = false;
    this._pollSession = 0;
    inlinesvg({ parent: this.shadowRoot, paths: ICONS });
    this.syncConfigPolling();

    if (this.details.view === 'sheet') {
      this.collabStatus = window.navigator.onLine
        ? 'connected'
        : 'offline';

      window.addEventListener('online', () => { this.collabStatus = 'connected'; });
      window.addEventListener('offline', () => { this.collabStatus = 'offline'; });
    }
  }

  disconnectedCallback() {
    this.clearConfigPolling();
    super.disconnectedCallback();
  }

  updated(changedProperties) {
    super.updated(changedProperties);
    if (changedProperties.has('details')) {
      this._actionsVis = this.getInitialActions();
      this._savingDisabled = false;
      this._isStaleIgnored = false;
      this.syncConfigPolling();
    }
  }

  firstUpdated() {
    const observer = new IntersectionObserver((entries) => {
      this._fixedActions = !entries[0].isIntersecting;
    });

    const element = this.shadowRoot.querySelector('h1');
    if (element) observer.observe(element);
  }

  handleError(json, action, icon) {
    // eslint-disable-next-line no-console
    console.log('handleError', json, action, icon);
    this._status = { ...json.error, action };
    icon.classList.remove('is-sending');
    icon.parentElement.classList.add('is-error');
  }

  getSnapshotHref(url, action) {
    const tldRepl = action === 'publish' ? 'aem.live' : 'aem.page';
    const pathParts = url.pathname.slice(1).toLowerCase().split('/');
    const snapName = pathParts.splice(0, 2)[1];
    const origin = url.origin
      .replace('https://', `https://${snapName}--`)
      .replace(tldRepl, 'aem.reviews');
    return `${origin}/${pathParts.join('/')}`;
  }

  getCdnHref(url, action, cdn) {
    const hostname = action === 'publish' ? cdn.prod : cdn.preview;
    if (!hostname) return url.href;
    return url.href.replace(url.origin, `https://${hostname}`);
  }

  async handleAction(action) {
    this.toggleActions();
    this._status = null;

    const sendBtn = this.shadowRoot.querySelector(
      this._isSaveOnlyView ? '.da-title-action' : '.da-title-action-send-icon',
    );

    if (sendBtn) {
      sendBtn.classList.add('is-sending');
    }

    const { hash } = window.location;
    const pathname = hash.replace('#', '');

    if (this.details.view === 'sheet' && action === 'save') {
      const dasSave = await saveToDa(pathname, this.sheet);
      if (sendBtn) sendBtn.classList.remove('is-sending');
      if (!dasSave.ok) return;
      this.hasChanges = false;
      return;
    }

    if (this._isConfigView) {
      if (this._savingDisabled) {
        if (sendBtn) {
          sendBtn.classList.remove('is-sending');
        }
        return;
      }
      const daConfigResp = await saveDaConfig(pathname, this.sheet);

      if (sendBtn) {
        sendBtn.classList.remove('is-sending');
      }

      if (!daConfigResp.ok) {
        // eslint-disable-next-line no-console
        console.log('Saving configuration failed because:', daConfigResp.status, await daConfigResp.text());
      } else {
        this.hasChanges = false;
        await this.cacheConfigData();
      }
      return;
    }
    if (action === 'preview' || action === 'publish') {
      const cdn = await getCdnConfig(pathname);

      const aemPath = this.sheet ? `${pathname}.json` : pathname;
      let json = await saveToAem(aemPath, 'preview');
      if (json.error) {
        this.handleError(json, 'preview', sendBtn);
        return;
      }
      if (action === 'publish') json = await saveToAem(aemPath, 'live');
      if (json.error) {
        this.handleError(json, 'publish', sendBtn);
        return;
      }
      const { url: href } = action === 'publish' ? json.live : json.preview;
      const url = new URL(href);
      const isSnap = url.pathname.startsWith('/.snapshots');
      const toOpen = isSnap ? this.getSnapshotHref(url, action) : this.getCdnHref(url, action, cdn);
      let toOpenInAem = toOpen.replace('.hlx.', '.aem.');

      if (this.previewPrefix || this.livePrefix) {
        const { pathname: path } = new URL(toOpenInAem);
        const origin = action === 'publish' ? this.livePrefix : this.previewPrefix;
        toOpenInAem = `${origin}${path}`;
      }

      window.open(`${toOpenInAem}?nocache=${Date.now()}`, toOpenInAem);
    }
    if (this.details.view === 'edit' && action === 'publish') saveDaVersion(pathname);
    if (sendBtn) sendBtn.classList.remove('is-sending');
  }

  async handleRoleRequest() {
    this._dialog = undefined;
    await import('../../shared/da-dialog/da-dialog.js');

    const { owner: org, repo: site } = this.details;

    const title = 'Role request';

    const action = {
      style: 'accent',
      label: 'OK',
      click: async () => { this._dialog = undefined; },
      disabled: true,
    };

    let content = html`<p>Requesting ${this._status.action} permissions...</p>`;
    this._dialog = { title, content, action };

    const { message } = await requestRole(org, site, this._status.action);

    content = html`<p>${message[0]}</p><p>${message[1]}</p>`;

    const closeAction = { ...action, disabled: false };
    this._dialog = { title, content, action: closeAction };
  }

  async fetchConfig() {
    const { owner, repo } = this.details;
    if (this.config) return this.config;

    const fetchSingleConfig = (path) => daFetch(path)
      .then((r) => r.json())
      .then(getFirstSheet)
      .then((data) => data ?? [])
      .catch(() => []);

    const [org, site] = await Promise.all([
      fetchSingleConfig(`${DA_ORIGIN}/config/${owner}`),
      fetchSingleConfig(`${DA_ORIGIN}/config/${owner}/${repo}`),
    ]);
    this.config = { org, site };
    return this.config;
  }

  async toggleActions() {
    if (this._isSaveOnlyView || this.isDotDADoc) {
      return;
    }

    // toggle off if already on
    if (this._actionsVis.length > 0) {
      this._actionsVis = [];
      return;
    }

    // check which actions should be allowed for the document based on config
    const config = await this.fetchConfig();
    const { fullpath } = this.details;

    const allConfigs = [...config.org, ...config.site];
    const publishButtonConfigs = allConfigs.filter((c) => c.key === 'editor.hidePublish');
    const hasMatchingPublishConfig = publishButtonConfigs.some((c) => fullpath.startsWith(c.value));

    this._actionsVis = hasMatchingPublishConfig ? ['preview'] : ['preview', 'publish'];
  }

  get _readOnly() {
    if (!this.permissions) return false;
    return !this.permissions.some((permission) => permission === 'write');
  }

  get _isConfigView() {
    return this.details.view === 'config';
  }

  get _isSaveOnlyView() {
    return this._isConfigView || this.details.view === 'sheet';
  }

  get isDotDADoc() {
    return this.details.view === 'edit' && this.details.fullpath.includes('/.da/');
  }

  getInitialActions() {
    if (this.isDotDADoc) {
      return [];
    }
    if (this._isSaveOnlyView) {
      return ['save'];
    }
    return [];
  }

  clearConfigPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  syncConfigPolling() {
    this._pollSession = (this._pollSession || 0) + 1;
    this.clearConfigPolling();
    if (!this._isConfigView || this._isStaleIgnored) {
      this._cachedConfigData = null;
      return;
    }
    this.startConfigPolling(this._pollSession);
  }

  async cacheConfigData() {
    const resp = await daFetch(this.details.sourceUrl);
    if (!resp.ok) return;
    this._cachedConfigData = JSON.stringify(await resp.json());
  }

  async startConfigPolling(pollSession) {
    await this.cacheConfigData();
    if (pollSession !== this._pollSession || this._isStaleIgnored) return;
    this.clearConfigPolling();
    this._pollInterval = setInterval(() => this.checkConfigChanges(), 30000);
  }

  async checkConfigChanges() {
    if (this._isStaleIgnored) return;
    const resp = await daFetch(this.details.sourceUrl);
    if (!resp.ok) return;
    const latestConfigData = JSON.stringify(await resp.json());
    if (!this._cachedConfigData) {
      this._cachedConfigData = latestConfigData;
      return;
    }
    if (latestConfigData !== this._cachedConfigData) {
      this.clearConfigPolling();
      this.showConfigStaleDialog();
    }
  }

  async showConfigStaleDialog() {
    await import('../../shared/da-dialog/da-dialog.js');
    this._dialog = {
      title: 'Config Updated',
      content: html`
        <p>The config has been updated. Please refresh to get the latest changes, or ignore to keep your existing edits.</p>
      `,
      action: {
        style: 'accent',
        label: 'Refresh',
        click: async () => this.handleConfigRefresh(),
      },
      ignoreAction: {
        style: 'primary outline',
        label: 'Ignore',
        click: () => this.handleConfigIgnore(),
      },
      close: () => this.handleConfigIgnore(),
    };
  }

  handleConfigIgnore() {
    this._dialog = undefined;
    this._savingDisabled = true;
    this._isStaleIgnored = true;
    this.clearConfigPolling();
  }

  async handleConfigRefresh() {
    this._dialog = undefined;
    this._savingDisabled = false;
    this._isStaleIgnored = false;
    this.hasChanges = false;
    const daSheet = document.querySelector('.da-sheet');
    if (!daSheet) return;
    const { default: initSheet, getData } = await import('../../sheet/utils/index.js');
    const freshData = await getData(this.details.sourceUrl);
    this.sheet = await initSheet(daSheet, freshData);
    this.syncConfigPolling();
  }

  renderActions() {
    const saveDisabled = this._isSaveOnlyView && (!this.hasChanges || this._savingDisabled);
    return html`${this._actionsVis.map((action) => html`
      <button
        @click=${() => this.handleAction(action)}
        class="con-button da-title-action ${saveDisabled ? '' : 'blue'}"
        aria-label="${action}"
        ?disabled=${saveDisabled}>
        ${action.charAt(0).toUpperCase() + action.slice(1)}
      </button>
    `)}`;
  }

  popover({ target }) {
    // If toggling off, simply remove;
    if (target.classList.contains('collab-popup')) {
      target.classList.remove('collab-popup');
      return;
    }
    // Find all open popups and close them
    const openPopups = this.shadowRoot.querySelectorAll('.collab-popup');
    openPopups.forEach((pop) => { pop.classList.remove('collab-popup'); });
    target.classList.add('collab-popup');
  }

  renderDialog() {
    return html`
      <da-dialog
        title=${this._dialog.title}
        .message=${this._dialog.message}
        .action=${this._dialog.action}
        @close=${this._dialog.close}>
        ${this._dialog.content}
        ${this._dialog.ignoreAction ? html`
          <sl-button
            slot="footer-right"
            class=${this._dialog.ignoreAction.style}
            @click=${this._dialog.ignoreAction.click}>
            ${this._dialog.ignoreAction.label}
          </sl-button>
          <sl-button
            slot="footer-right"
            class=${this._dialog.action.style}
            @click=${this._dialog.action.click}
            ?disabled=${this._dialog.action.disabled}>
            ${this._dialog.action.label}
          </sl-button>
        ` : nothing}
      </da-dialog>
    `;
  }

  renderCollabUsers() {
    return html`${this.collabUsers.map((user) => {
      const initials = user.split(' ').map((name) => name.toString().substring(0, 1));
      return html`<div class="collab-icon collab-icon-user" data-popup-content="${user}" @click=${this.popover}>${initials.join('')}</div>`;
    })}`;
  }

  renderCollab() {
    return html`
      <div class="collab-status">
        ${this.collabUsers ? this.renderCollabUsers() : nothing}
        <div class="collab-icon collab-status-cloud collab-status-${this.collabStatus}" data-popup-content="${this.collabStatus}" @click=${this.popover}>
         <svg class="icon"><use href="#${CLOUD_ICONS[this.collabStatus]}"/></svg>
        </div>
      </div>`;
  }

  renderError() {
    return html`
      <div class="da-title-error">
        <p><strong>${this._status.message}</strong></p>
        ${this._status.details ? html`<p>${this._status.details}</p>` : nothing}
        ${this._status.status === 403 ? html`<button @click=${this.handleRoleRequest}>Request access</button>` : nothing}
      </div>`;
  }

  render() {
    return html`
      <div class="da-title-inner ${this._readOnly ? 'is-read-only' : ''}">
        <div class="da-title-name">
          <a
            href="/#${this.details.parent}"
            class="da-title-name-label">${this.details.parentName}</a>
          <h1>${this.details.name}</h1>
        </div>
        <div class="da-title-collab-actions-wrapper">
          ${this.collabStatus ? this.renderCollab() : nothing}
          ${this._status ? this.renderError() : nothing}
          ${this.isDotDADoc ? nothing : html`
            <div class="da-title-actions ${this._fixedActions ? 'is-fixed' : ''} ${!this._isSaveOnlyView && this._actionsVis.length > 0 ? 'is-open' : ''} ${this._isSaveOnlyView ? 'save-only' : ''}">
              ${this.renderActions()}
              ${this._isSaveOnlyView ? nothing : html`
                <button
                  @click=${this.toggleActions}
                  class="con-button blue da-title-action-send"
                  aria-label="Send">
                  <span class="da-title-action-send-icon"></span>
                </button>
              `}
            </div>
          `}
        </div>
      </div>
      ${this._isConfigView && this._savingDisabled
    ? html`<p class="da-title-save-disabled-msg">Saving is disabled until the config has been refreshed. If you have unsaved changes that you want to preserve, you can copy them and merge them after refreshing the config.</p>`
    : nothing}
      ${this._dialog ? this.renderDialog() : nothing}
    `;
  }
}

customElements.define('da-title', DaTitle);
