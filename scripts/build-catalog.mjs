// 青空文庫の「公開中 作家別作品一覧拡張版」CSVから、アプリが読む data/catalog.json を作る。
//   node scripts/build-catalog.mjs                   公式サイトからCSVを取得して作る(通常はこれ)
//   node scripts/build-catalog.mjs --csv=list.csv    手元のCSVから作る
//   node scripts/build-catalog.mjs --tree=tree.txt   本文リポジトリのファイル一覧で、本文の場所を補正する(任意)
//   オプション --out=data/catalog.json  --ranking-base=<人気順の取得元>(通常は指定不要)
// 人気順は、青空文庫のアクセスランキング(直近3年)を取得して作る。取得できなければ人気順なしで作る。
// 著作権が切れた作品(作品・人物の著作権フラグがともに「なし」)で、本文テキストがあるものだけを載せる。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const OUT = arg('out') || 'data/catalog.json';
const CSV_URL = 'https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip';

async function getCsv() {
  if (arg('csv')) return readFileSync(arg('csv'), 'utf8');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`CSVを取得できませんでした: ${res.status} ${CSV_URL}`);
  const dir = mkdtempSync(join(tmpdir(), 'aozora-'));
  const zip = join(dir, 'list.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  return execFileSync('unzip', ['-p', zip], { maxBuffer: 1 << 29 }).toString('utf8');
}

function parseCsv(s) {
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const hira = (s) => (s || '').replace(/[\s　・]/g, '').replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const rows = parseCsv(await getCsv());
const head = rows.shift();
const col = (name) => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`CSVに列「${name}」がありません。列: ${head.slice(0, 30).join(' / ')}`);
  return i;
};
const C = Object.fromEntries(
  ['作品ID', '作品名', '作品名読み', '副題', '副題読み', '作品著作権フラグ', '人物ID', '姓', '名', '姓読み', '名読み', '役割フラグ', '人物著作権フラグ', 'テキストファイルURL'].map((n) => [n, col(n)]),
);

// 本文リポジトリのファイル一覧(任意): cards/<人物ID>/files/<作品ID>_xxx/<作品ID>_xxx.txt
const tree = new Map();
if (arg('tree')) {
  for (const l of readFileSync(arg('tree'), 'utf8').split('\n')) {
    const m = l.trim().match(/^cards\/(\d+)\/files\/([^/]+)\/\2\.txt$/);
    if (m) tree.set(`${m[1]}/${m[2].split('_')[0]}`, m[2]);
  }
}

const works = new Map();
for (const r of rows) {
  if (r.length < head.length - 5) continue;
  if (r[C['作品著作権フラグ']] !== 'なし' || r[C['人物著作権フラグ']] !== 'なし') continue;
  const id = r[C['作品ID']].replace(/^0+/, '');
  const pid = r[C['人物ID']];
  let base = null;
  const m = r[C['テキストファイルURL']].match(/cards\/(\d+)\/files\/([^/]+)\.zip$/);
  if (tree.size) base = tree.get(`${pid}/${id}`) || null;
  else if (m) base = m[2];
  if (!base) continue;
  const role = r[C['役割フラグ']];
  const prev = works.get(id);
  if (prev && (prev.role === '著者' || role !== '著者')) continue;
  const sub = r[C['副題']];
  works.set(id, {
    role,
    id,
    t: r[C['作品名']] + (sub ? `　${sub}` : ''),
    rt: hira(r[C['作品名読み']] + r[C['副題読み']]),
    a: (r[C['姓']] + r[C['名']]).trim(),
    ra: hira(r[C['姓読み']] + r[C['名読み']]),
    p: `${pid}/${base}`,
    key: `${pid}/${id}`,
  });
}

// 人気順: アクセスランキングのページに並ぶ「図書カードへのリンク」の順番を、そのまま順位として使う。
const RB = arg('ranking-base') || 'https://www.aozora.gr.jp/access_ranking';
async function popularity() {
  const score = new Map();
  const y = new Date().getFullYear();
  for (const yr of [y, y - 1, y - 2]) {
    for (const kind of ['xhtml', 'txt']) {
      const url = `${RB}/${yr}_${kind}.html`;
      try {
        const r = await fetch(url);
        if (!r.ok) { console.warn(`ranking skip: ${url} (${r.status})`); continue; }
        const html = Buffer.from(await r.arrayBuffer()).toString('latin1'); // 使うのは英数字のURLだけ
        const keys = [...new Set([...html.matchAll(/cards\/(\d+)\/card(\d+)\.html/g)].map((m) => `${m[1]}/${Number(m[2])}`))];
        keys.forEach((k, i) => score.set(k, (score.get(k) || 0) + Math.max(0, 1000 - i)));
        console.log(`ranking: ${url} -> ${keys.length} works`);
      } catch (e) {
        console.warn(`ranking error: ${url} (${String(e).slice(0, 80)})`);
      }
    }
  }
  return score;
}
const pop = await popularity();

const coll = new Intl.Collator('ja');
const list = [...works.values()].sort((x, y) => coll.compare(x.rt, y.rt) || x.id - y.id);
const byAuthor = list
  .map((w, i) => i)
  .sort((x, y) => coll.compare(list[x].ra, list[y].ra) || coll.compare(list[x].a, list[y].a) || x - y);

const sc = list.map((w) => pop.get(w.key) || 0);
const hasPop = sc.some((x) => x > 0);
const byPop = hasPop ? list.map((w, i) => i).sort((x, y) => sc[y] - sc[x] || x - y) : null;
console.log(hasPop ? `popularity: ${sc.filter((x) => x > 0).length} works ranked` : 'popularity: no ranking data (人気順なしで作ります)');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), w: list.map((w) => [w.id, w.t, w.rt, w.a, w.ra, w.p]), a: byAuthor, ...(byPop ? { p: byPop } : {}) }),
);
console.log(`catalog: ${list.length} works -> ${OUT}`);
