import { LitElement, html, nothing } from 'da-lit';

import getSheet from '../../shared/sheet.js';
import '../da-editor/da-editor.js';
import { getLivePreviewUrl } from '../../shared/constants.js';
import { hasValidCommentSelection } from '../prose/plugins/comments/commentPlugin.js';

const sheet = await getSheet('/blocks/edit/da-content/da-content.css');

export default class DaContent extends LitElement {
  static properties = {
    details: { attribute: false },
    permissions: { attribute: false },
    proseEl: { attribute: false },
    wsProvider: { attribute: false },
    lockdownImages: { attribute: false },
    currentUser: { attribute: false },
    _editorLoaded: { state: true },
    _showPane: { state: true },
    _versionUrl: { state: true },
    _externalUrl: { state: true },
    _commentCount: { state: true },
    _canAddComment: { state: true },
  };

  constructor() {
    super();
    this._commentCount = 0;
    this._canAddComment = false;
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.adoptedStyleSheets = [sheet];
    window.addEventListener('da-selection-change', this.handleSelectionChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('da-selection-change', this.handleSelectionChange);
  }

  handleSelectionChange() {
    this._canAddComment = window.view ? hasValidCommentSelection(window.view.state) : false;
  }

  renderCommentBadge() {
    if (this._canAddComment) {
      return html`<span class="da-comment-badge">+</span>`;
    }

    if (this._commentCount > 0) {
      return html`<span class="da-comment-badge">${this._commentCount}</span>`;
    }

    return nothing;
  }

  disconnectWebsocket() {
    if (this.wsProvider) {
      this.wsProvider.disconnect({ data: 'Client navigation' });
      this.wsProvider = undefined;
    }
  }

  async loadViews() {
    if (this._editorLoaded) return;

    const preview = import('../da-preview/da-preview.js');
    const versions = import('../da-versions/da-versions.js');
    const comments = import('../da-comments/da-comments.js');
    await Promise.all([preview, versions, comments]);
    this._editorLoaded = true;
  }

  async loadUe() {
    const { default: getExternalUrl } = await import('./helpers/index.js');
    this._externalUrl = await getExternalUrl(
      this.details.owner,
      this.details.repo,
      this.details.previewUrl,
    );
  }

  async handleEditorLoaded() {
    this.loadViews();
    this.loadUe();
  }

  openUe() {
    window.location = this._externalUrl;
  }

  togglePane({ detail }) {
    this._showPane = detail;
  }

  handleVersionReset() {
    this._versionUrl = null;
  }

  handleVersionPreview({ detail }) {
    this._versionUrl = detail.url;
  }

  render() {
    const { owner, repo, previewUrl } = this.details;
    const { pathname } = new URL(previewUrl);

    // Only use livePreviewUrl if lockdownImages flag is set to true
    const displayUrl = this.lockdownImages
      ? `${getLivePreviewUrl(owner, repo)}${pathname}`
      : previewUrl;

    return html`
      <div class="editor-wrapper">
        <da-editor
          path="${this.details.sourceUrl}"
          version="${this._versionUrl}"
          .permissions=${this.permissions}
          .proseEl=${this.proseEl}
          .wsProvider=${this.wsProvider}
          @proseloaded=${this.handleEditorLoaded}
          @versionreset=${this.handleVersionReset}>
        </da-editor>
        ${this._editorLoaded ? html`
          <div class="da-editor-tabs ${this._showPane ? 'show-pane' : ''}">
            <div class="da-editor-tabs-full">
              <button
                class="da-editor-tab show-preview"
                title="Preview" @click=${() => this.togglePane({ detail: 'preview' })}>Preview</button>
            </div>
            <div class="da-editor-tabs-quiet">
              <button class="da-editor-tab quiet show-versions" title="Versions" @click=${() => this.togglePane({ detail: 'versions' })}>Versions</button>
              ${this._externalUrl ? html`<button class="da-editor-tab quiet open-ue" title="Open in-context editing" @click=${this.openUe}>Open in-context editing</button>` : nothing}
              <button
                class="da-editor-tab quiet show-comments ${this._showPane === 'comments' ? 'is-active' : ''}"
                title="${this._canAddComment ? 'Add comment' : 'Comments'}"
                @click=${() => this.togglePane({ detail: 'comments' })}>
                Comments
                ${this.renderCommentBadge()}
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
      ${this._editorLoaded ? html`
        <da-preview
          path=${displayUrl}
          .show=${this._showPane === 'preview'}
          .lockdownImages=${this.lockdownImages}
          class="${this._showPane === 'preview' ? 'is-visible' : ''}"
          @close=${this.togglePane}></da-preview>
        <da-versions
          path=${this.details.fullpath}
          .open=${this._showPane === 'versions'}
          class="${this._showPane === 'versions' ? 'is-visible' : ''}"
          @preview=${this.handleVersionPreview}
          @close=${this.togglePane}></da-versions>
        <da-comments
          class="${this._showPane === 'comments' ? 'is-visible' : ''}"
          .open=${this._showPane === 'comments'}
          .currentUser=${this.currentUser}
          @close=${this.togglePane}
          @request-open=${() => { this._showPane = 'comments'; }}
          @count-changed=${(e) => { this._commentCount = e.detail; }}></da-comments>
        ` : nothing}
    `;
  }
}

customElements.define('da-content', DaContent);
