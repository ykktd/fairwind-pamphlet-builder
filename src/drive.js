const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_FOLDER = 'application/vnd.google-apps.folder';

let scriptPromise;
function script(url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Googleの接続用スクリプトを読み込めませんでした。'));
    document.head.append(el);
  });
}

async function loadScripts() {
  scriptPromise ||= Promise.all([
    script('https://accounts.google.com/gsi/client'),
    script('https://apis.google.com/js/api.js'),
  ]).then(() => new Promise((resolve, reject) => {
    window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Pickerを読み込めませんでした。')) });
  }));
  return scriptPromise;
}

export const preloadGoogleScripts = () => loadScripts();

async function responseOrError(response) {
  if (response.ok) return response;
  let detail = '';
  try {
    const data = await response.json();
    detail = data.error?.message || '';
  } catch { /* HTTP status is still useful. */ }
  if (response.status === 401) throw new Error('Googleへの接続が切れました。再接続してください。');
  if (response.status === 403) throw new Error(`このDrive資料を操作する権限がありません。${detail}`);
  throw new Error(`Google ドライブでエラーが発生しました（${response.status}）。${detail}`);
}

export class DriveClient {
  constructor(settings) {
    this.settings = settings;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenClient = null;
  }

  get configured() {
    return Boolean(this.settings.clientId && this.settings.apiKey && this.settings.appId);
  }

  get connected() {
    return Boolean(this.token && Date.now() < this.tokenExpiresAt - 30000);
  }

  async connect() {
    if (!this.configured) throw new Error('Google接続の設定がまだありません。');
    await loadScripts();
    this.tokenClient ||= window.google.accounts.oauth2.initTokenClient({
      client_id: this.settings.clientId,
      scope: SCOPE,
      callback: () => {},
    });
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = response => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || 'Googleへの接続が完了しませんでした。'));
          return;
        }
        this.token = response.access_token;
        this.tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3500) * 1000;
        resolve();
      };
      this.tokenClient.requestAccessToken({ prompt: this.token ? '' : 'consent' });
    });
  }

  disconnect() {
    if (this.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(this.token, () => {});
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async request(path, options = {}) {
    if (!this.connected) throw new Error('Googleへの接続が切れています。再接続してください。');
    const url = path.startsWith('https://') ? path : `${DRIVE_API}${path}`;
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.token}`);
    return responseOrError(await fetch(url, { ...options, headers }));
  }

  async pick({ folder = false, pdfOrDoc = false, parentId = null } = {}) {
    if (!this.connected) throw new Error('Googleに接続してください。');
    await loadScripts();
    return new Promise(resolve => {
      const picker = window.google.picker;
      const view = folder
        ? new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true)
        : new picker.DocsView(picker.ViewId.DOCS);
      if (parentId) view.setParent(parentId);
      if (pdfOrDoc) view.setMimeTypes(`application/pdf,${MIME_DOC}`);
      const dialog = new picker.PickerBuilder()
        .setDeveloperKey(this.settings.apiKey)
        .setAppId(this.settings.appId)
        .setOAuthToken(this.token)
        .addView(view)
        .setCallback(data => {
          if (data.action === picker.Action.PICKED) {
            const selected = data[picker.Response.DOCUMENTS]?.[0];
            resolve(selected ? {
              id: selected[picker.Document.ID],
              name: selected[picker.Document.NAME],
              mimeType: selected[picker.Document.MIME_TYPE],
            } : null);
          } else if (data.action === picker.Action.CANCEL) resolve(null);
        })
        .build();
      dialog.setVisible(true);
    });
  }

  async metadata(id) {
    const response = await this.request(`/files/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink,parents&supportsAllDrives=true`);
    return response.json();
  }

  async pdfBytes(source) {
    const id = encodeURIComponent(source.id);
    const path = source.mimeType === MIME_DOC
      ? `/files/${id}/export?mimeType=application%2Fpdf`
      : `/files/${id}?alt=media`;
    const response = await this.request(path);
    return new Uint8Array(await response.arrayBuffer());
  }

  async listChildren(parentId, name) {
    const escaped = name.replaceAll("'", "\\'");
    const q = `'${parentId}' in parents and name = '${escaped}' and trashed = false`;
    const response = await this.request(`/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType),nextPageToken&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    return (await response.json()).files || [];
  }

  async ensureWorkFolder(parentId) {
    const existing = (await this.listChildren(parentId, 'パンフ作成用')).find(file => file.mimeType === MIME_FOLDER);
    if (existing) return existing;
    const response = await this.request('/files?fields=id,name,mimeType&supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'パンフ作成用', mimeType: MIME_FOLDER, parents: [parentId] }),
    });
    return response.json();
  }

  async copyFile(fileId, folderId, name) {
    const response = await this.request(`/files/${encodeURIComponent(fileId)}/copy?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    return response.json();
  }

  async uploadFile(folderId, name, blob, mimeType) {
    const boundary = `fairwind_${crypto.randomUUID().replaceAll('-', '')}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType })}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ], { type: `multipart/related; boundary=${boundary}` });
    const response = await this.request(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return response.json();
  }

  async updateFile(fileId, blob, mimeType) {
    const response = await this.request(`${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,mimeType&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: blob,
    });
    return response.json();
  }

  async saveManifest(folderId, manifestId, project) {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    if (manifestId) return this.updateFile(manifestId, blob, 'application/json');
    return this.uploadFile(folderId, 'パンフ構成.json', blob, 'application/json');
  }

  async loadManifest(folderId) {
    const file = (await this.listChildren(folderId, 'パンフ構成.json'))[0];
    if (!file) return null;
    const response = await this.request(`/files/${encodeURIComponent(file.id)}?alt=media`);
    return { project: await response.json(), manifestId: file.id };
  }
}
