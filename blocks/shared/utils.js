import { DA_ORIGIN } from './constants.js';

const { getNx } = await import('../../scripts/utils.js');

// TODO: INFRA
const DA_ORIGINS = ['https://da.live', 'https://da.page', 'https://admin.da.live', 'https://admin.da.page', 'https://stage-admin.da.live', 'https://content.da.live', 'https://stage-content.da.live', 'http://localhost:8787', 'https://da-admin-usman.7qrnczsck7.workers.dev'];
const AEM_ORIGINS = ['https://admin.hlx.page', 'https://admin.aem.live'];
const ALLOWED_TOKEN = [...DA_ORIGINS, ...AEM_ORIGINS];

let imsDetails;

export async function initIms() {
  if (imsDetails) return imsDetails;
  const { loadIms } = await import(`${getNx()}/utils/ims.js`);

  try {
    imsDetails = await loadIms();
    return imsDetails;
  } catch {
    return null;
  }
}

export const daFetch = async (url, opts = {}) => {
  opts.headers = opts.headers || {};
  let accessToken;
  if (localStorage.getItem('nx-ims')) {
    ({ accessToken } = await initIms());
    const canToken = ALLOWED_TOKEN.some((origin) => new URL(url).origin === origin);
    if (accessToken && canToken) {
      opts.headers.Authorization = `Bearer ${accessToken.token}`;
      if (AEM_ORIGINS.some((origin) => new URL(url).origin === origin)) {
        opts.headers['x-content-source-authorization'] = `Bearer ${accessToken.token}`;
      }
    }
  }
  const resp = await fetch(url, opts);
  if (resp.status === 401 && opts.noRedirect !== true) {
    // Only attempt sign-in if the request is for DA.
    if (DA_ORIGINS.some((origin) => url.startsWith(origin))) {
      // If the user has an access token, but are not permitted, redirect them to not found.
      if (accessToken) {
        // eslint-disable-next-line no-console
        console.warn('You see the 404 page because you have no access to this page', url);
        window.location = `${window.location.origin}/not-found`;
        return { ok: false };
      }
      // eslint-disable-next-line no-console
      console.warn('You need to sign in because you are not authorized to access this page', url);
      const { loadIms, handleSignIn } = await import(`${getNx()}/utils/ims.js`);
      await loadIms();
      handleSignIn();
    }
  }

  // TODO: Properly support 403 - DA Admin sometimes gives 401s and sometimes 403s.
  if (resp.status === 403) {
    return resp;
  }

  // If child actions header is present, use it.
  // This is a hint as to what can be done with the children.
  if (resp.headers?.get('x-da-child-actions')) {
    resp.permissions = resp.headers.get('x-da-child-actions').split('=').pop().split(',');
    return resp;
  }

  // Use the self actions hint if child actions are not present.
  if (resp.headers?.get('x-da-actions')) {
    resp.permissions = resp.headers?.get('x-da-actions')?.split('=').pop().split(',');
    return resp;
  }

  // Support legacy admin.role.all
  resp.permissions = ['read', 'write'];
  return resp;
};

export async function aemAdmin(path, api, method = 'POST') {
  const [owner, repo, ...parts] = path.slice(1).split('/');
  const name = parts.pop() || repo || owner;
  parts.push(name.replace('.html', ''));
  const aemUrl = `https://admin.hlx.page/${api}/${owner}/${repo}/main/${parts.join('/')}`;
  const resp = await daFetch(aemUrl, { method });
  if (method === 'DELETE' && resp.status === 204) return {};
  if (!resp.ok) return undefined;
  try {
    return resp.json();
  } catch {
    return undefined;
  }
}

export async function saveToDa({ path, formData, blob, props, preview = false }) {
  const opts = { method: 'PUT' };

  const form = formData || new FormData();
  if (blob || props) {
    if (blob) form.append('data', blob);
    if (props) form.append('props', JSON.stringify(props));
  }
  if ([...form.keys()].length) opts.body = form;

  const daResp = await daFetch(`${DA_ORIGIN}/source${path}`, opts);
  if (!daResp.ok) return undefined;
  if (!preview) return undefined;
  return aemAdmin(path, 'preview');
}

export const getSheetByIndex = (json, index = 0) => {
  if (json[':type'] !== 'multi-sheet') {
    return json.data;
  }
  return json[Object.keys(json)[index]]?.data;
};

export const getFirstSheet = (json) => getSheetByIndex(json, 0);

/**
 * Generate a consistent color for a user based on an identifier.
 * Used for cursor colors and avatar backgrounds.
 * @param {string} identifier - User email, ID, or other unique string
 * @param {number[]} hRange - Hue range [min, max]
 * @param {number[]} sRange - Saturation range [min, max]
 * @param {number[]} lRange - Lightness range [min, max]
 * @returns {string} Hex color string
 */
export function generateColor(identifier, hRange = [0, 360], sRange = [60, 80], lRange = [40, 60]) {
  let hash = 0;
  for (let i = 0; i < identifier.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = identifier.charCodeAt(i) + ((hash << 5) - hash);
  }
  hash = Math.abs(hash);
  const normalizeHash = (min, max) => Math.floor((hash % (max - min)) + min);
  const h = normalizeHash(hRange[0], hRange[1]);
  const s = normalizeHash(sRange[0], sRange[1]);
  const l = normalizeHash(lRange[0], lRange[1]) / 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
