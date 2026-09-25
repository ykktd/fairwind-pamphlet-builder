import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildPamphlet, BuildError } from './core/pdf.js';
import { parseWikiProfiles } from './core/wiki.js';
import { DriveClient } from './drive.js';
import { getLocalFile, loadProject, loadSettings, putLocalFile, saveProject, saveSettings } from './storage.js';
import './style.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const app = document.querySelector('#app');
const DEFAULT_COMMON_FOLDER = '18ilhAvxClYjeOe86hYM2rzr2SzZuDLG1';
const deploymentSettings = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY || '',
  appId: import.meta.env.VITE_GOOGLE_APP_ID || '',
  commonFolderId: import.meta.env.VITE_COMMON_FOLDER_ID || DEFAULT_COMMON_FOLDER,
};
const blankProject = () => ({ id: crypto.randomUUID(), title: '新しい企画', items: [], wikiText: '', folderId: null, workFolderId: null, manifestId: null, outputs: [] });
let project = loadProject() || blankProject();
let settings = { ...deploymentSettings, ...loadSettings() };
let drive = new DriveClient(settings);
let selectedId = project.items[0]?.id || 'toc';
let buildResult = null;
let previewDocument = null;
let previewUrl = null;
let previewPage = 1;
let isBusy = false;
let saveTimer;
let saveInFlight = Promise.resolve();
let statusText = '資料を追加してパンフレットを作成してください。';
let statusError = false;
let lastIssues = [];
let renderVersion = 0;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const selectedItem = () => project.items.find(item => item.id === selectedId);
const kindName = kind => ({ cover: '表紙', section: '資料', profiles: 'プロフィール' }[kind] || '資料');
const isGoogleDoc = source => source?.mimeType === 'application/vnd.google-apps.document';

function setStatus(message, error = false) {
  statusText = message;
  statusError = error;
  const el = document.querySelector('#status');
  if (el) {
    el.textContent = message;
    el.classList.toggle('error', error);
  }
}

function queueSave() {
  saveProject(project);
  clearTimeout(saveTimer);
  if (!drive.connected || !project.workFolderId) return;
  const snapshot = structuredClone(project);
  const client = drive;
  saveTimer = setTimeout(() => {
    saveInFlight = saveInFlight.catch(() => {}).then(async () => {
      try {
        const manifestId = snapshot.manifestId || (project.id === snapshot.id ? project.manifestId : null);
        const saved = await client.saveManifest(snapshot.workFolderId, manifestId, snapshot);
        if (project.id === snapshot.id) {
          if (!project.manifestId) {
            project.manifestId = saved.id;
            saveProject(project);
          }
          setStatus('企画の変更をDriveに保存しました。');
        }
      } catch (error) {
        if (project.id === snapshot.id) setStatus(`企画をDriveに保存できませんでした: ${error.message}`, true);
      }
    });
  }, 850);
}

function clearBuiltPdf() {
  renderVersion += 1;
  buildResult = null;
  previewDocument = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  lastIssues = [];
  const panel = document.querySelector('.preview-toolbar')?.closest('.panel');
  if (panel?.querySelector('.preview-layout')) {
    panel.querySelector('.pdf-meta')?.remove();
    panel.querySelector('.preview-layout')?.remove();
    panel.querySelector('.footer-actions')?.remove();
    panel.insertAdjacentHTML('beforeend', '<div class="preview-empty"><div><h3>PDFを再生成してください</h3><p>資料または目次を変更しました。再生成すると、目次とページ番号が更新されます。</p></div></div>');
  }
}

function showSelection() {
  document.querySelectorAll('.section-row').forEach(row => {
    const button = row.querySelector('[data-action="select"]');
    const selected = button?.dataset.id === selectedId;
    row.classList.toggle('selected', selected);
    if (button) button.setAttribute('aria-current', selected ? 'true' : 'false');
  });
  const container = document.querySelector('.settings-panel .right-sticky');
  if (container) container.innerHTML = settingsMarkup();
}

function itemMarkup(item, index) {
  const active = selectedId === item.id ? 'selected' : '';
  const pageCount = item.pageCount ? `${item.pageCount}ページ` : kindName(item.kind);
  return `<div class="section-row ${active}" draggable="${index > 0}" data-drag-id="${escapeHtml(item.id)}">
    <button class="section-select" data-action="select" data-id="${escapeHtml(item.id)}" aria-current="${active ? 'true' : 'false'}">
      <span class="section-name">${escapeHtml(item.title || item.source?.name || '資料')}</span>
      <span class="section-meta">${escapeHtml(pageCount)}${item.source?.type === 'local' ? ' · このブラウザ' : ''}</span>
    </button>
    <div class="row-controls">
      ${index > 1 ? `<button class="icon-btn" data-action="move-up" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}を上へ移動">↑</button>` : ''}
      ${index > 0 && index < project.items.length - 1 ? `<button class="icon-btn" data-action="move-down" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}を下へ移動">↓</button>` : ''}
    </div>
  </div>`;
}

function listMarkup() {
  if (!project.items.length) return `<div class="notice">最初に表紙のPDFを追加してください。</div>`;
  return project.items.map((item, index) => {
    if (index === 0) return `${itemMarkup(item, index)}<div class="section-row toc ${selectedId === 'toc' ? 'selected' : ''}"><button class="section-select" data-action="select" data-id="toc"><span class="section-name">目次</span><span class="section-meta">自動生成</span></button></div>`;
    return itemMarkup(item, index);
  }).join('');
}

function sourceLink(item) {
  if (item.source?.type !== 'drive') return '';
  const url = isGoogleDoc(item.source)
    ? `https://docs.google.com/document/d/${encodeURIComponent(item.source.id)}/edit`
    : `https://drive.google.com/file/d/${encodeURIComponent(item.source.id)}/view`;
  return `<a class="button full" href="${url}" target="_blank" rel="noopener noreferrer">${isGoogleDoc(item.source) ? 'Google ドキュメントを開く' : 'Driveで元資料を開く'}</a>`;
}

function settingsMarkup() {
  if (selectedId === 'toc') return `<h2>目次</h2><p class="muted">資料の順番とプロフィール一覧から自動で作ります。ページ番号は完成PDFに合わせて計算します。</p><div class="notice">目次の位置は表紙の次です。プロフィールはWikiの一覧をそのまま貼り付けてください。</div>`;
  const item = selectedItem();
  if (!item) return `<h2>資料の設定</h2><p class="muted">左の一覧から資料を選んでください。</p>`;
  const profile = item.kind === 'profiles';
  const parsed = parseWikiProfiles(project.wikiText);
  const overrideCount = Object.keys(item.overrides || {}).length;
  return `<h2>資料の設定</h2>
    <div class="field"><label for="item-title">目次に表示する見出し</label><input id="item-title" type="text" value="${escapeHtml(item.title)}" data-change="item-title" /></div>
    <div class="field"><label>元資料</label><div class="file-name"><span class="file-icon" aria-hidden="true">▤</span><span>${escapeHtml(item.source?.name || '未設定')}</span></div><p class="field-hint">${item.source?.type === 'drive' ? 'Drive上の元資料を再生成時に読み込みます。' : 'このブラウザに保存されています。'}</p></div>
    <div class="field">${sourceLink(item)}</div>
    ${profile ? '<div class="field"><p class="field-hint">プロフィールは全員を個別に目次へ載せます。</p></div>' : item.kind !== 'cover' ? `<div class="field"><label class="checkbox"><input type="checkbox" data-change="include-toc" ${item.includeToc !== false ? 'checked' : ''} />目次に載せる</label></div>` : ''}
    ${profile ? `<div class="field"><label for="wiki-list">Wikiのプロフィール一覧</label><p class="field-hint">「p.nn 氏名（〇〇学部m年）」の行を順番のまま貼り付けます。先頭の番号は使わず、完成PDFの番号を付け直します。</p><textarea id="wiki-list" data-change="wiki-list" placeholder="p.15 山田花子（工学部3年）">${escapeHtml(project.wikiText)}</textarea><p class="field-hint">読み取り: ${parsed.profiles.length}人${parsed.errors.length ? ` / 読み取れない行: ${parsed.errors.map(error => error.line).join('、')}` : ''}。PDF: ${item.pageCount || '未確認'}ページ。</p></div>` : ''}
    <h3>差し替え</h3>
    <p class="muted">元資料全体または中の1ページを差し替えられます。元のPDFは変更しません。</p>
    <div class="button-row"><button class="button" data-action="replace-local">資料全体を差し替え</button>${drive.connected ? `<button class="button" data-action="replace-drive">Driveから差し替え</button>` : ''}</div>
    ${item.pageCount > 1 ? `<div class="field" style="margin-top:15px"><label for="replace-page-number">1ページだけ差し替える</label><select id="replace-page-number">${Array.from({ length: item.pageCount }, (_, i) => `<option value="${i}">${i + 1}ページ目${item.overrides?.[i] ? '（差し替え済み）' : ''}</option>`).join('')}</select><div class="button-row"><button class="button" data-action="replace-page-local">PCのPDFを選ぶ</button>${drive.connected ? `<button class="button" data-action="replace-page-drive">Driveから選ぶ</button>` : ''}</div>${overrideCount ? `<p class="field-hint">${overrideCount}ページを差し替えています。</p>` : ''}</div>` : ''}
    <div class="footer-actions">${item.kind !== 'cover' ? `<button class="button danger" data-action="remove-item">この資料を外す</button>` : ''}</div>`;
}

function render() {
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><span class="brand">FairWind パンフレット作成</span><input class="project-title" aria-label="企画名" type="text" id="project-title" value="${escapeHtml(project.title)}" />
      <div class="top-actions"><button class="button subtle" data-action="new-project">新しい企画</button><button class="button" data-action="open-google-settings">Google接続の設定</button><button class="button ${drive.connected ? '' : 'subtle'}" data-action="connect-google">${drive.connected ? 'Google接続済み' : 'Googleに接続'}</button></div></header>
    <div id="status" class="status ${statusError ? 'error' : ''}" role="status">${escapeHtml(statusText)}</div>
    <main class="workspace">
      <section class="panel"><div class="panel-heading"><h2>資料一覧</h2><span class="pill">${project.items.length}資料</span></div>
        <div class="section-list">${listMarkup()}</div>
        <div class="add-box"><label for="add-kind">追加する資料</label><select id="add-kind" ${project.items.length ? '' : 'disabled'}><option value="section">通常の資料</option><option value="profiles">プロフィールPDF</option></select>
          <div class="button-row"><button class="button" data-action="add-local">${project.items.length ? 'PCのPDFを追加' : '表紙PDFを追加'}</button><button class="button" data-action="add-drive" ${drive.connected ? '' : 'disabled'}>Driveから追加</button><button class="button" data-action="add-common" ${drive.connected && project.workFolderId ? '' : 'disabled'}>共通資料から追加</button></div>
          ${!drive.connected ? `<p class="field-hint">Driveを使うには「Google接続の設定」から設定します。</p>` : ''}
          ${drive.connected && !project.workFolderId ? '<p class="field-hint">共通資料を選ぶ前に企画共有フォルダを選んでください。</p>' : ''}
        </div>
        <div class="project-folder"><h3>保存先</h3><p class="muted">${project.workFolderId ? '企画共有フォルダ内の「パンフ作成用」' : 'まだ選択されていません。'}</p><button class="button" data-action="choose-folder" ${drive.connected ? '' : 'disabled'}>企画共有フォルダを選ぶ</button>
          ${project.outputs?.length ? `<h3>保存した完成PDF</h3><div class="saved-outputs">${project.outputs.map(output => `<a href="https://drive.google.com/file/d/${encodeURIComponent(output.id)}/view" target="_blank" rel="noopener noreferrer">${escapeHtml(output.name)}</a>`).join('')}</div>` : ''}</div>
      </section>
      <section class="panel"><div class="panel-heading"><h2>ページのプレビュー</h2><div class="preview-toolbar"><button class="button primary" data-action="build" ${isBusy || project.items.length < 2 ? 'disabled' : ''}>${isBusy ? '生成中…' : 'PDFを再生成'}</button></div></div>
        ${lastIssues.length ? `<div class="notice error"><strong>生成前に確認してください</strong><ul class="issues">${lastIssues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div>` : ''}
        ${buildResult ? `<div class="pdf-meta"><span class="pill">全${buildResult.totalPages}ページ</span><span class="pill">目次${buildResult.tocPages}ページ</span><span class="pill">${buildResult.totalPages % 4 === 0 ? '4の倍数です' : `4の倍数まであと${4 - buildResult.totalPages % 4}ページ`}</span></div><div class="preview-layout"><div id="thumb-grid" class="thumb-grid" aria-label="ページ一覧"></div><div class="page-view"><canvas id="large-page"></canvas><p id="page-caption" class="page-caption"></p></div></div><div class="footer-actions"><button class="button" data-action="download">PDFをダウンロード</button><button class="button" data-action="save-pdf" ${drive.connected && project.workFolderId ? '' : 'disabled'}>Driveに保存</button></div>` : `<div class="preview-empty"><div><h3>完成PDFをここで確認</h3><p>資料を並べた後に「PDFを再生成」を押すと、目次とページ番号を付けた全ページを表示します。</p></div></div>`}
      </section>
      <aside class="panel settings-panel"><div class="right-sticky">${settingsMarkup()}</div></aside>
    </main>
    <footer class="site-footer"><span>FairWind パンフレット作成</span><a href="./privacy.html">プライバシーについて</a></footer>
    <input id="pdf-file-input" type="file" accept="application/pdf,.pdf" hidden />
    <dialog id="google-settings"><h2>Google接続の設定</h2><p class="muted">公開時に設定済みなら入力は不要です。手動で変更した値はこのブラウザに保存します。</p><form method="dialog" id="settings-form" class="dialog-grid">
      <div><label for="client-id">OAuth クライアント ID</label><input id="client-id" type="text" required value="${escapeHtml(settings.clientId || '')}" /></div>
      <div><label for="api-key">APIキー</label><input id="api-key" type="text" required value="${escapeHtml(settings.apiKey || '')}" /></div>
      <div><label for="app-id">Google Cloud プロジェクト番号</label><input id="app-id" type="text" required value="${escapeHtml(settings.appId || '')}" /></div>
      <div><label for="common-folder">共通資料フォルダのID</label><input id="common-folder" type="text" value="${escapeHtml(settings.commonFolderId || DEFAULT_COMMON_FOLDER)}" /><p class="field-hint">作成手順書にある共通ページのDriveフォルダを初期値にしています。</p></div>
      <div class="dialog-actions"><button class="button" value="cancel">閉じる</button><button class="button primary" id="save-settings" value="save">保存</button></div>
    </form></dialog>
  </div>`;
  if (buildResult) void renderPreview();
}

async function sourceBytes(source) {
  if (source.type === 'drive') return drive.pdfBytes(source);
  const file = await getLocalFile(source.key);
  if (!file) throw new Error(`${source.name}がこのブラウザに見つかりません。再追加してください。`);
  return new Uint8Array(await file.arrayBuffer());
}

async function countPages(source) {
  const pdf = await PDFDocument.load(await sourceBytes(source));
  return pdf.getPageCount();
}

async function localSource(file) {
  if (!file || (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf')) throw new Error('PDFファイルを選んでください。');
  if (drive.connected && project.workFolderId) {
    const saved = await drive.uploadFile(project.workFolderId, file.name, file, 'application/pdf');
    return { type: 'drive', id: saved.id, name: saved.name, mimeType: 'application/pdf' };
  }
  const key = crypto.randomUUID();
  await putLocalFile(key, file);
  return { type: 'local', key, name: file.name, mimeType: 'application/pdf' };
}

async function pickedSource(copyTemplate = false, parentId = null, pinCommon = false) {
  const picked = await drive.pick({ pdfOrDoc: true, parentId });
  if (!picked) return null;
  const meta = await drive.metadata(picked.id);
  if (!['application/pdf', 'application/vnd.google-apps.document'].includes(meta.mimeType)) throw new Error('PDFまたはGoogle ドキュメントを選んでください。');
  if ((copyTemplate && isGoogleDoc(meta)) || pinCommon) {
    if (!project.workFolderId) throw new Error('企画用コピーを作るには、先に企画共有フォルダを選んでください。');
    const copied = await drive.copyFile(meta.id, project.workFolderId, `${project.title} ${meta.name}`);
    return { type: 'drive', id: copied.id, name: copied.name, mimeType: copied.mimeType };
  }
  return { type: 'drive', id: meta.id, name: meta.name, mimeType: meta.mimeType };
}

async function addItem(source, kind) {
  const pageCount = await countPages(source);
  if (kind === 'cover' && pageCount !== 1) throw new Error('表紙は1ページのPDFにしてください。');
  if (kind === 'profiles' && project.items.some(item => item.kind === 'profiles')) throw new Error('プロフィールPDFは1つだけ登録できます。');
  const item = { id: crypto.randomUUID(), kind, title: kind === 'cover' ? '表紙' : kind === 'profiles' ? '参加大学生プロフィール' : source.name.replace(/\.pdf$/i, ''), source, pageCount, includeToc: kind !== 'cover', overrides: {} };
  project.items.push(item);
  selectedId = item.id;
  clearBuiltPdf();
  queueSave();
  isBusy = false;
  render();
  setStatus(`${item.title}を追加しました。`);
}

async function chooseLocalFile(callback) {
  const input = document.querySelector('#pdf-file-input');
  input.value = '';
  return new Promise(resolve => {
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(); return; }
      try { await callback(file); }
      catch (error) { setStatus(error.message, true); }
      resolve();
    };
    input.click();
  });
}

async function build() {
  isBusy = true;
  lastIssues = [];
  render();
  setStatus('資料を読み込み、PDFを生成しています。');
  try {
    const [jp, num] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}fonts/NotoSansJP-Regular.ttf`).then(response => response.arrayBuffer()),
      fetch(`${import.meta.env.BASE_URL}fonts/SourceSans3-Regular.ttf`).then(response => response.arrayBuffer()),
    ]);
    const result = await buildPamphlet({ items: project.items, wikiText: project.wikiText, getBytes: sourceBytes, japaneseFontBytes: jp, numberFontBytes: num });
    clearBuiltPdf();
    buildResult = result;
    previewUrl = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
    previewPage = 1;
    setStatus(`全${result.totalPages}ページのPDFを生成しました。`);
  } catch (error) {
    lastIssues = error instanceof BuildError && error.details.length ? error.details : [error.message];
    setStatus('PDFを生成できませんでした。確認項目をご覧ください。', true);
  } finally {
    isBusy = false;
    render();
  }
}

async function renderPreview() {
  const version = ++renderVersion;
  if (!buildResult) return;
  try {
    previewDocument = await pdfjs.getDocument({ data: buildResult.bytes.slice() }).promise;
    if (version !== renderVersion) return;
    const grid = document.querySelector('#thumb-grid');
    if (!grid) return;
    grid.innerHTML = Array.from({ length: previewDocument.numPages }, (_, index) => `<button class="thumb ${previewPage === index + 1 ? 'selected' : ''}" data-action="preview-page" data-page="${index + 1}" aria-label="${index + 1}ページを表示"><canvas id="thumb-${index + 1}"></canvas><span>${index + 1}</span></button>`).join('');
    for (let index = 1; index <= previewDocument.numPages; index += 1) {
      if (version !== renderVersion) return;
      const page = await previewDocument.getPage(index);
      const canvas = document.querySelector(`#thumb-${index}`);
      if (!canvas) return;
      const viewport = page.getViewport({ scale: 0.25 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    await renderLargePage();
  } catch (error) {
    setStatus(`プレビューを表示できませんでした: ${error.message}`, true);
  }
}

async function renderLargePage() {
  if (!previewDocument) return;
  const page = await previewDocument.getPage(previewPage);
  const canvas = document.querySelector('#large-page');
  if (!canvas) return;
  const viewport = page.getViewport({ scale: 1.25 });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const caption = document.querySelector('#page-caption');
  if (caption) caption.textContent = `${previewPage} / ${previewDocument.numPages}ページ`;
}

function moveItem(id, direction) {
  const index = project.items.findIndex(item => item.id === id);
  const destination = index + direction;
  if (index <= 0 || destination <= 0 || destination >= project.items.length) return;
  [project.items[index], project.items[destination]] = [project.items[destination], project.items[index]];
  clearBuiltPdf();
  queueSave();
  render();
}

async function replaceWhole(source) {
  const item = selectedItem();
  if (!item) return;
  const count = await countPages(source);
  if (item.kind === 'cover' && count !== 1) throw new Error('表紙は1ページのPDFにしてください。');
  item.source = source;
  item.pageCount = count;
  item.overrides = {};
  clearBuiltPdf();
  queueSave();
  render();
  setStatus(`${item.title}を差し替えました。`);
}

async function replacePage(source) {
  const item = selectedItem();
  const index = Number(document.querySelector('#replace-page-number')?.value);
  if (!item || !Number.isInteger(index)) return;
  const count = await countPages(source);
  if (count !== 1) throw new Error('差し替える資料は1ページのPDFにしてください。');
  item.overrides ||= {};
  item.overrides[index] = source;
  clearBuiltPdf();
  queueSave();
  render();
  setStatus(`${item.title}の${index + 1}ページを差し替えました。`);
}

async function chooseFolder() {
  const picked = await drive.pick({ folder: true });
  if (!picked) return;
  if (project.items.length && !window.confirm('選んだ企画フォルダに既存のパンフ構成があれば、現在の画面から切り替えます。Driveに未保存の内容がある場合は先に保存してください。続けますか？')) return;
  const folder = await drive.ensureWorkFolder(picked.id);
  const found = await drive.loadManifest(folder.id);
  if (found) {
    project = { ...blankProject(), ...found.project, folderId: picked.id, workFolderId: folder.id, manifestId: found.manifestId };
    selectedId = project.items[0]?.id || 'toc';
    setStatus('Driveから企画を開きました。');
  } else {
    project.folderId = picked.id;
    project.workFolderId = folder.id;
    project.manifestId = null;
    for (const item of project.items) {
      if (item.source?.type === 'local') {
        const file = await getLocalFile(item.source.key);
        if (!file) throw new Error(`${item.source.name}がこのブラウザに見つかりません。再追加してください。`);
        const saved = await drive.uploadFile(folder.id, item.source.name, file, 'application/pdf');
        item.source = { type: 'drive', id: saved.id, name: saved.name, mimeType: 'application/pdf' };
      }
      for (const [page, source] of Object.entries(item.overrides || {})) {
        if (source.type !== 'local') continue;
        const file = await getLocalFile(source.key);
        if (!file) throw new Error(`${source.name}がこのブラウザに見つかりません。再追加してください。`);
        const saved = await drive.uploadFile(folder.id, source.name, file, 'application/pdf');
        item.overrides[page] = { type: 'drive', id: saved.id, name: saved.name, mimeType: 'application/pdf' };
      }
    }
    setStatus('「パンフ作成用」フォルダを用意しました。');
    queueSave();
  }
  clearBuiltPdf();
  saveProject(project);
  render();
}

async function savePdf() {
  if (!buildResult || !drive.connected || !project.workFolderId) return;
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const name = `${project.title.replaceAll(/[\\/:*?"<>|]/g, '_')}_${stamp}.pdf`;
  const file = await drive.uploadFile(project.workFolderId, name, new Blob([buildResult.bytes], { type: 'application/pdf' }), 'application/pdf');
  project.outputs.unshift({ id: file.id, name: file.name, createdAt: new Date().toISOString() });
  queueSave();
  setStatus(`完成PDFをDriveの「パンフ作成用」に保存しました: ${name}`);
}

function downloadPdf() {
  if (!previewUrl) return;
  const a = document.createElement('a');
  a.href = previewUrl;
  a.download = `${project.title.replaceAll(/[\\/:*?"<>|]/g, '_')}.pdf`;
  a.click();
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'select') { selectedId = id; showSelection(); return; }
  if (action === 'move-up') { moveItem(id, -1); return; }
  if (action === 'move-down') { moveItem(id, 1); return; }
  if (action === 'preview-page') {
    previewPage = Number(button.dataset.page);
    document.querySelectorAll('.thumb').forEach(el => el.classList.toggle('selected', Number(el.dataset.page) === previewPage));
    await renderLargePage();
    return;
  }
  if (action === 'open-google-settings') { document.querySelector('#google-settings').showModal(); return; }
  if (action === 'connect-google') { await drive.connect(); setStatus('Google ドライブに接続しました。'); render(); return; }
  if (action === 'choose-folder') { await chooseFolder(); return; }
  if (action === 'new-project') {
    if (project.items.length && !window.confirm('新しい企画を作りますか？現在の企画を後で開くには、先に企画共有フォルダを選んでDriveに保存してください。')) return;
    project = blankProject(); selectedId = 'toc'; clearBuiltPdf(); saveProject(project); render(); setStatus('新しい企画を作りました。'); return;
  }
  if (action === 'add-local') {
    const kind = project.items.length ? document.querySelector('#add-kind').value : 'cover';
    isBusy = true;
    try { await chooseLocalFile(async file => addItem(await localSource(file), kind)); }
    finally { isBusy = false; render(); }
    return;
  }
  if (action === 'add-drive') {
    const kind = project.items.length ? document.querySelector('#add-kind').value : 'cover';
    isBusy = true;
    try {
      const source = await pickedSource(true);
      if (source) await addItem(source, kind);
    } finally { isBusy = false; render(); }
    return;
  }
  if (action === 'add-common') {
    const kind = project.items.length ? document.querySelector('#add-kind').value : 'cover';
    isBusy = true;
    try {
      const source = await pickedSource(false, settings.commonFolderId || DEFAULT_COMMON_FOLDER, true);
      if (source) await addItem(source, kind);
    } finally { isBusy = false; render(); }
    return;
  }
  if (action === 'build') { await build(); return; }
  if (action === 'download') { downloadPdf(); return; }
  if (action === 'save-pdf') { await savePdf(); return; }
  if (action === 'replace-local') { await chooseLocalFile(async file => replaceWhole(await localSource(file))); return; }
  if (action === 'replace-drive') { const source = await pickedSource(false); if (source) await replaceWhole(source); return; }
  if (action === 'replace-page-local') { await chooseLocalFile(async file => replacePage(await localSource(file))); return; }
  if (action === 'replace-page-drive') { const source = await pickedSource(false); if (source) await replacePage(source); return; }
  if (action === 'remove-item') {
    const item = selectedItem();
    if (!item) return;
    project.items = project.items.filter(current => current.id !== item.id);
    selectedId = project.items.at(-1)?.id || 'toc';
    clearBuiltPdf(); queueSave(); render(); setStatus(`${item.title}を企画から外しました。`); return;
  }
}

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  if (isBusy && button.dataset.action !== 'preview-page') return;
  try { await handleAction(button); }
  catch (error) { setStatus(error.message, true); }
});

app.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'project-title') { project.title = target.value.trim() || '新しい企画'; queueSave(); return; }
  const item = selectedItem();
  if (target.dataset.change === 'item-title' && item) { item.title = target.value.trim() || item.source.name; clearBuiltPdf(); queueSave(); setStatus('見出しを変更しました。PDFを再生成してください。'); return; }
  if (target.dataset.change === 'include-toc' && item) { item.includeToc = target.checked; clearBuiltPdf(); queueSave(); setStatus('目次の設定を変更しました。PDFを再生成してください。'); return; }
  if (target.dataset.change === 'wiki-list') { project.wikiText = target.value; clearBuiltPdf(); queueSave(); setStatus('Wikiの一覧を更新しました。PDFを再生成してください。'); }
});

app.addEventListener('click', event => {
  if (event.target.id !== 'save-settings') return;
  event.preventDefault();
  const dialog = document.querySelector('#google-settings');
  const form = document.querySelector('#settings-form');
  if (!form.reportValidity()) { event.preventDefault(); return; }
  settings = {
    clientId: document.querySelector('#client-id').value.trim(),
    apiKey: document.querySelector('#api-key').value.trim(),
    appId: document.querySelector('#app-id').value.trim(),
    commonFolderId: document.querySelector('#common-folder').value.trim(),
  };
  saveSettings(settings);
  drive = new DriveClient(settings);
  dialog.close();
  render();
  setStatus('Google接続の設定を保存しました。「Googleに接続」を押してください。');
});

let draggedId = null;
app.addEventListener('dragstart', event => {
  const row = event.target.closest('[data-drag-id]');
  if (!row || row.getAttribute('draggable') !== 'true') return;
  draggedId = row.dataset.dragId;
  event.dataTransfer.effectAllowed = 'move';
});
app.addEventListener('dragover', event => {
  if (draggedId && event.target.closest('[data-drag-id]')) event.preventDefault();
});
app.addEventListener('drop', event => {
  const target = event.target.closest('[data-drag-id]');
  if (!target || !draggedId) return;
  event.preventDefault();
  const sourceIndex = project.items.findIndex(item => item.id === draggedId);
  const targetIndex = project.items.findIndex(item => item.id === target.dataset.dragId);
  if (sourceIndex > 0 && targetIndex > 0 && sourceIndex !== targetIndex) {
    const [item] = project.items.splice(sourceIndex, 1);
    project.items.splice(targetIndex, 0, item);
    clearBuiltPdf(); queueSave(); render();
  }
  draggedId = null;
});
app.addEventListener('dragend', () => { draggedId = null; });

render();
