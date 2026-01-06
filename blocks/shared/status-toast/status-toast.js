import { html, nothing } from 'da-lit';

/**
 * Render a status toast overlay
 * @param {Object} status - The status object with text, description (optional), and type
 * @param {string} status.text - The title text
 * @param {string} [status.description] - Optional description text
 * @param {string} [status.type='info'] - The type of toast (info, success, error, warning)
 * @returns {TemplateResult} The toast HTML template
 */
export function renderStatusToast(status) {
  if (!status) return nothing;
  return html`
    <div class="da-status-toast-overlay">
      <div class="da-status-toast da-status-toast-type-${status.type || 'info'}">
        <p class="da-status-toast-title">${status.text}</p>
        ${status.description ? html`<p class="da-status-toast-description">${status.description}</p>` : nothing}
      </div>
    </div>`;
}

/**
 * Show a status toast for a duration then clear it
 * @param {Function} setStatus - Function to set the status state
 * @param {string} text - The title text
 * @param {string} [description] - Optional description text
 * @param {string} [type='info'] - The type of toast
 * @param {number} [duration=3000] - Duration in ms before auto-dismiss
 */
export function showStatus(setStatus, text, description, type = 'info', duration = 3000) {
  setStatus(text, description, type);
  setTimeout(() => { setStatus(null); }, duration);
}

