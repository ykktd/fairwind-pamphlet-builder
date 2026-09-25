import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { buildPamphlet, BuildError } from '../src/core/pdf.js';
import { parseWikiProfiles } from '../src/core/wiki.js';

const jp = await readFile(new URL('../public/fonts/NotoSansJP-Regular.ttf', import.meta.url));
const num = await readFile(new URL('../public/fonts/SourceSans3-Regular.ttf', import.meta.url));

async function blankPdf(count) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i += 1) pdf.addPage(PageSizes.A4);
  return pdf.save();
}

function item(id, kind, pageCount) {
  return { id, kind, title: id, pageCount, includeToc: true, source: { id, name: `${id}.pdf` } };
}

test('Wikiの行順を保ち、元のp.nnを完成ページ番号として使わない', () => {
  const result = parseWikiProfiles('p.15 山田花子（工学部3年）\np.999 佐藤太郎（文科一類2年）\n');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.profiles, [
    { name: '山田花子', detail: '工学部3年' },
    { name: '佐藤太郎', detail: '文科一類2年' },
  ]);
});

test('目次が2ページになり、途中の資料を増やすとプロフィールの参照先が更新される', async () => {
  const files = {
    cover: await blankPdf(1),
    worksheet: await blankPdf(2),
    extra: await blankPdf(1),
    profiles: await blankPdf(40),
    article: await blankPdf(1),
  };
  const wikiText = Array.from({ length: 40 }, (_, index) => `p.${index + 15} 大学生${index + 1}（工学部3年）`).join('\n');
  const base = [item('cover', 'cover', 1), item('worksheet', 'section', 2), item('profiles', 'profiles', 40), item('article', 'section', 1)];
  const build = items => buildPamphlet({ items, wikiText, getBytes: source => files[source.id], japaneseFontBytes: jp, numberFontBytes: num });

  const first = await build(base);
  assert.equal(first.tocPages, 2);
  assert.equal(first.totalPages, 46);
  assert.equal(first.entries.find(entry => entry.title.startsWith('大学生1（')).page, 6);
  assert.equal(first.entries.find(entry => entry.title.startsWith('大学生40（')).page, 45);

  const updated = await build([base[0], base[1], item('extra', 'section', 1), base[2], base[3]]);
  assert.equal(updated.totalPages, 47);
  assert.equal(updated.entries.find(entry => entry.title.startsWith('大学生1（')).page, 7);
  assert.equal((await PDFDocument.load(updated.bytes)).getPageCount(), 47);
});

test('氏名一覧とプロフィールの枚数が違う場合は出力しない', async () => {
  const files = { cover: await blankPdf(1), profiles: await blankPdf(2) };
  await assert.rejects(
    buildPamphlet({
      items: [item('cover', 'cover', 1), item('profiles', 'profiles', 2)],
      wikiText: 'p.15 山田花子（工学部3年）',
      getBytes: source => files[source.id],
      japaneseFontBytes: jp,
      numberFontBytes: num,
    }),
    error => error instanceof BuildError && error.details.some(detail => detail.includes('PDFが2ページ')),
  );
});
