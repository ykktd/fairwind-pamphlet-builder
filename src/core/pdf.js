import { PDFDocument, PageSizes, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { parseWikiProfiles } from './wiki.js';

const A4 = PageSizes.A4;
const A4_TOLERANCE = 3;

export class BuildError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'BuildError';
    this.details = details;
  }
}

function isA4(page) {
  return Math.abs(page.getWidth() - A4[0]) <= A4_TOLERANCE &&
    Math.abs(page.getHeight() - A4[1]) <= A4_TOLERANCE;
}

function wrapText(text, maxWidth, font, size) {
  const result = [];
  let current = '';
  for (const char of text) {
    if (current && font.widthOfTextAtSize(current + char, size) > maxWidth) {
      result.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result.length ? result : [''];
}

function paginateToc(entries, japaneseFont) {
  const pages = [[]];
  const textSize = 11;
  const lineHeight = 17;
  const firstY = 747;
  const minY = 67;
  let y = firstY;
  for (const entry of entries) {
    const x = entry.profile ? 78 : 56;
    const lines = wrapText(entry.title, 477 - x, japaneseFont, textSize);
    const rowHeight = Math.max(1, lines.length) * lineHeight + (entry.profile ? 0 : 6);
    if (y - rowHeight < minY) {
      pages.push([]);
      y = firstY;
    }
    pages.at(-1).push({ ...entry, x, y, lines, textSize, lineHeight });
    y -= rowHeight;
  }
  return pages;
}

async function loadSource(source, getBytes) {
  if (!source) throw new BuildError('資料が指定されていません。');
  const bytes = await getBytes(source);
  const pdf = await PDFDocument.load(bytes);
  if (pdf.getPageCount() === 0) throw new BuildError(`${source.name ?? '資料'} にページがありません。`);
  return pdf;
}

function computeEntries(sections, profiles, tocCount) {
  let page = 2 + tocCount;
  const entries = [{ title: '目次', page: 2, profile: false }];
  const starts = new Map();
  for (const section of sections.slice(1)) {
    starts.set(section.item.id, page);
    if (section.item.kind === 'profiles' || section.item.includeToc !== false) {
      entries.push({ title: section.item.title || section.item.source?.name || '資料', page, profile: false });
      if (section.item.kind === 'profiles') {
        profiles.forEach((person, index) => {
          entries.push({ title: `${person.name}（${person.detail}）`, page: page + index, profile: true });
        });
      }
    }
    page += section.pdf.getPageCount();
  }
  return { entries, starts, total: page - 1 };
}

export async function buildPamphlet({ items, wikiText, getBytes, japaneseFontBytes, numberFontBytes }) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new BuildError('表紙と本文の資料を追加してください。');
  }
  if (items[0].kind !== 'cover') {
    throw new BuildError('最初の資料を表紙にしてください。');
  }
  if (!japaneseFontBytes || !numberFontBytes) {
    throw new BuildError('PDF用フォントを読み込めませんでした。');
  }

  const sections = [];
  const issues = [];
  for (const item of items) {
    let pdf;
    try {
      pdf = await loadSource(item.source, getBytes);
    } catch (error) {
      if (error instanceof BuildError) throw error;
      throw new BuildError(`${item.title || '資料'}を読み込めませんでした: ${error.message}`);
    }
    for (const [index, page] of pdf.getPages().entries()) {
      if (!isA4(page)) issues.push(`${item.title || '資料'}の${index + 1}ページがA4縦ではありません。`);
    }
    const overrides = new Map();
    for (const [indexText, source] of Object.entries(item.overrides || {})) {
      const index = Number(indexText);
      if (!Number.isInteger(index) || index < 0 || index >= pdf.getPageCount()) {
        issues.push(`${item.title || '資料'}の差し替え位置が元PDFのページ数を超えています。`);
        continue;
      }
      const replacement = await loadSource(source, getBytes);
      if (replacement.getPageCount() !== 1 || !isA4(replacement.getPage(0))) {
        issues.push(`${item.title || '資料'}の${index + 1}ページの差し替え資料はA4縦の1ページPDFにしてください。`);
      } else {
        overrides.set(index, replacement);
      }
    }
    sections.push({ item, pdf, overrides });
  }

  if (sections[0].pdf.getPageCount() !== 1) issues.push('表紙は1ページのPDFにしてください。');
  const profileSections = sections.filter(section => section.item.kind === 'profiles');
  if (profileSections.length > 1) issues.push('プロフィールPDFは1つにまとめて登録してください。');
  const parsed = parseWikiProfiles(wikiText);
  if (profileSections.length) {
    if (parsed.errors.length) issues.push(`Wikiの一覧に読み取れない行があります: ${parsed.errors.map(error => error.line).join('、')}行目`);
    if (parsed.profiles.length !== profileSections[0].pdf.getPageCount()) {
      issues.push(`プロフィールはPDFが${profileSections[0].pdf.getPageCount()}ページ、Wikiの一覧が${parsed.profiles.length}人です。`);
    }
  }
  if (issues.length) throw new BuildError('資料を確認してください。', issues);

  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const jp = await output.embedFont(japaneseFontBytes, { subset: false });
  const num = await output.embedFont(numberFontBytes, { subset: false });

  let tocCount = 1;
  let tocPages;
  let plan;
  for (let pass = 0; pass < 10; pass += 1) {
    plan = computeEntries(sections, parsed.profiles, tocCount);
    tocPages = paginateToc(plan.entries, jp);
    if (tocPages.length === tocCount) break;
    tocCount = tocPages.length;
  }
  if (tocPages.length !== tocCount) throw new BuildError('目次のページ数が確定しませんでした。');
  plan = computeEntries(sections, parsed.profiles, tocCount);

  const [cover] = await output.copyPages(sections[0].pdf, [0]);
  output.addPage(cover);
  for (const [index, rows] of tocPages.entries()) {
    const page = output.addPage(A4);
    page.drawText(index === 0 ? '目次' : '目次（続き）', { x: 55, y: 787, size: 20, font: jp, color: rgb(0, 0, 0) });
    page.drawLine({ start: { x: 55, y: 778 }, end: { x: 541, y: 778 }, thickness: 0.7, color: rgb(0.55, 0.55, 0.55) });
    for (const row of rows) {
      row.lines.forEach((line, lineIndex) => {
        page.drawText(line, { x: row.x, y: row.y - lineIndex * row.lineHeight, size: row.textSize, font: jp, color: rgb(0, 0, 0) });
      });
      const pageText = `p.${row.page}`;
      const width = num.widthOfTextAtSize(pageText, 11);
      page.drawText(pageText, { x: 541 - width, y: row.y, size: 11, font: num, color: rgb(0, 0, 0) });
    }
  }

  for (const section of sections.slice(1)) {
    for (let index = 0; index < section.pdf.getPageCount(); index += 1) {
      const source = section.overrides.get(index) ?? section.pdf;
      const sourceIndex = section.overrides.has(index) ? 0 : index;
      const [page] = await output.copyPages(source, [sourceIndex]);
      output.addPage(page);
    }
  }

  output.getPages().forEach((page, index) => {
    if (index === 0) return;
    const label = String(index + 1);
    const width = num.widthOfTextAtSize(label, 11);
    page.drawText(label, { x: (page.getWidth() - width) / 2, y: 20, size: 11, font: num, color: rgb(0, 0, 0) });
  });
  output.setTitle('FairWind パンフレット');
  const bytes = await output.save();
  return {
    bytes,
    totalPages: output.getPageCount(),
    tocPages: tocCount,
    entries: plan.entries,
    starts: Object.fromEntries(plan.starts),
  };
}
