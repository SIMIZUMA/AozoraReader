// 青空文庫の「公開中 作家別作品一覧拡張版」CSVから、アプリが読む data/catalog.json を作る。
//   node scripts/build-catalog.mjs                   公式サイトからCSVを取得して作る(通常はこれ)
//   node scripts/build-catalog.mjs --csv=list.csv    手元のCSVから作る
//   node scripts/build-catalog.mjs --tree=tree.txt   本文リポジトリのファイル一覧で、本文の場所を補正する(任意)
//   オプション --out=data/catalog.json  --ranking-base=<人気順の取得元>(通常は指定不要)
// 人気順(全期間・年間・月間)は、青空文庫のアクセスランキングから作る。取得できなければ人気順なしで作る。
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

// 人気順: 公式のアクセスランキング(XHTML版・テキスト版、各500位)から、3つの並びを作る。
//   all=全期間(公開されている全年の年間ランキングを足し合わせ)、y=年間(最新の年)、m=月間(最新の月)
//   ランキングのページに並ぶ「図書カードへのリンク」の順番を、そのまま順位として使う。
//   注意: 公式のランキングは更新が止まっていることがあるので、取れた中で最新のものを使う。
const RB = arg('ranking-base') || 'https://www.aozora.gr.jp/access_ranking';
const latin1 = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return Buffer.from(await r.arrayBuffer()).toString('latin1'); // 使うのは英数字のURLだけ
};
async function popularity() {
  let idx = '';
  try {
    idx = await latin1(`${RB}/`);
  } catch (e) {
    console.warn(`ranking index: ${String(e).slice(0, 80)}`);
  }
  const find = (re) => [...new Set([...idx.matchAll(re)].map((m) => m[1]))];
  const yearly = find(/[\/"'](\d{4}_(?:xhtml|txt)\.html)/g);
  const monthly = find(/[\/"'](\d{4}_\d{2}_(?:xhtml|txt)\.html)/g);
  if (!yearly.length) {
    for (let yr = 2009; yr <= new Date().getFullYear(); yr++) for (const k of ['xhtml', 'txt']) yearly.push(`${yr}_${k}.html`);
  }
  const cache = new Map();
  const keysOf = async (f) => {
    if (cache.has(f)) return cache.get(f);
    let keys = [];
    try {
      const html = await latin1(`${RB}/${f}`);
      keys = [...new Set([...html.matchAll(/cards\/(\d+)\/card(\d+)\.html/g)].map((m) => `${m[1]}/${Number(m[2])}`))];
    } catch (e) {
      /* そのページは飛ばす */
    }
    cache.set(f, keys);
    return keys;
  };
  const agg = async (files) => {
    const score = new Map();
    for (const f of files) (await keysOf(f)).forEach((k, i) => score.set(k, (score.get(k) || 0) + Math.max(0, 1000 - i)));
    return score;
  };
  const latest = (files, pick) => {
    if (!files.length) return { top: null, files: [] };
    const top = files.map(pick).sort().pop();
    return { top, files: files.filter((f) => pick(f) === top) };
  };
  const ly = latest(yearly, (f) => f.slice(0, 4));
  const lm = latest(monthly, (f) => f.slice(0, 7).replace('_', '-'));
  const res = { all: await agg(yearly), y: await agg(ly.files), m: await agg(lm.files), meta: { y: ly.top, m: lm.top } };
  console.log(`ranking pages read: ${[...cache.values()].filter((k) => k.length).length}/${cache.size} (year ${ly.top}, month ${lm.top})`);
  return res;
}
const pop = await popularity();

const coll = new Intl.Collator('ja');
const list = [...works.values()].sort((x, y) => coll.compare(x.rt, y.rt) || x.id - y.id);
const byAuthor = list
  .map((w, i) => i)
  .sort((x, y) => coll.compare(list[x].ra, list[y].ra) || coll.compare(list[x].a, list[y].a) || x - y);

const order = (score) => {
  const sc = list.map((w) => score.get(w.key) || 0);
  return sc.some((x) => x > 0) ? list.map((w, i) => i).sort((x, y) => sc[y] - sc[x] || x - y) : null;
};
const pp = {};
for (const k of ['all', 'y', 'm']) {
  const o = order(pop[k]);
  if (o) pp[k] = o;
}
console.log(Object.keys(pp).length ? `popularity: ${Object.keys(pp).join(', ')}` : 'popularity: no ranking data (人気順なしで作ります)');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), w: list.map((w) => [w.id, w.t, w.rt, w.a, w.ra, w.p]), a: byAuthor, ...(pp.all ? { pp, pm: pop.meta } : {}) }),
);
console.log(`catalog: ${list.length} works -> ${OUT}`);
