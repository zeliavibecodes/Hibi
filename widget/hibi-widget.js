// Hibi widget for Scriptable — large size.
// Left: today. Right: this month, shaded by Japanese practice time, with a dot when you finished something.
// Bottom: three words to review from your jpdb decks, new ones each day.
// Run it once inside Scriptable to save your GitHub key (same as Hibi) and your jpdb key (same as Yomu).

const HIBI_URL = 'https://zeliavibecodes.github.io/Hibi/';
const YOMU_URL = 'https://zeliavibecodes.github.io/Yomu/';
const SYNC_FILE = 'hibi-sync.json';
const PRACTICE = ['reading-time', 'listening', 'flash', 'passive', 'gaming'];
const FINISHED = ['manga', 'jp-novel', 'book', 'jp-game', 'game'];

const C = {
  bg: new Color('#0C0C0D'),
  ink: new Color('#EDEDEC'),
  ink2: new Color('#BDBDC0'),
  muted: new Color('#8E8E93'),
  hair: new Color('#FFFFFF', 0.08),
};
const MINCHO = (size, bold) => new Font(bold ? 'HiraMinProN-W6' : 'HiraMinProN-W3', size);

// ---------- keys ----------
const KC = { gh: 'hibi.github', jpdb: 'hibi.jpdb', gist: 'hibi.gist' };
function getKey(k) { return Keychain.contains(k) ? Keychain.get(k) : ''; }

async function askKeys() {
  const a = new Alert();
  a.title = 'Hibi widget';
  a.message = 'Paste your GitHub key (the one Hibi uses) and your jpdb key (the one Yomu uses). They stay on this phone.';
  a.addSecureTextField('GitHub key', getKey(KC.gh));
  a.addSecureTextField('jpdb key', getKey(KC.jpdb));
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if (await a.present() === -1) return;
  const gh = a.textFieldValue(0).trim(), jp = a.textFieldValue(1).trim();
  if (gh !== getKey(KC.gh) && Keychain.contains(KC.gist)) Keychain.remove(KC.gist);
  if (gh) Keychain.set(KC.gh, gh);
  if (jp) Keychain.set(KC.jpdb, jp);
  cache.clear();
}

// ---------- small file cache, so the widget still shows something offline ----------
const fm = FileManager.local();
const dir = fm.joinPath(fm.documentsDirectory(), 'hibi-widget');
if (!fm.fileExists(dir)) fm.createDirectory(dir);
const cache = {
  read(name) { const p = fm.joinPath(dir, name); try { return fm.fileExists(p) ? JSON.parse(fm.readString(p)) : null; } catch (e) { return null; } },
  write(name, v) { fm.writeString(fm.joinPath(dir, name), JSON.stringify(v)); },
  clear() { ['entries.json', 'words.json', 'vocab.json'].forEach((n) => { const p = fm.joinPath(dir, n); if (fm.fileExists(p)) fm.remove(p); }); },
};

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const TODAY = key(today);

// ---------- Hibi entries from the private Gist ----------
async function gh(path) {
  const r = new Request('https://api.github.com' + path);
  r.headers = { Authorization: 'Bearer ' + getKey(KC.gh), Accept: 'application/vnd.github+json' };
  r.timeoutInterval = 15;
  const body = await r.loadJSON();
  if (r.response.statusCode >= 400) throw new Error('GitHub ' + r.response.statusCode);
  return body;
}
async function loadEntries() {
  if (!getKey(KC.gh)) return cache.read('entries.json');
  try {
    let id = getKey(KC.gist);
    if (!id) {
      const list = await gh('/gists?per_page=100');
      const g = list.find((x) => x.files && x.files[SYNC_FILE]);
      if (!g) throw new Error('No Hibi Gist yet');
      id = g.id; Keychain.set(KC.gist, id);
    }
    const g = await gh('/gists/' + id);
    const f = g.files[SYNC_FILE];
    let text = f.content;
    if (f.truncated) text = await new Request(f.raw_url).loadString();
    const data = JSON.parse(text || '{}');
    const entries = (data.entries || []).filter((e) => !(data.deleted || {})[e.id]);
    cache.write('entries.json', entries);
    return entries;
  } catch (e) {
    return cache.read('entries.json');
  }
}

// ---------- words from jpdb ----------
async function jpdb(endpoint, body) {
  const r = new Request('https://jpdb.io/api/v1/' + endpoint);
  r.method = 'POST';
  r.headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + getKey(KC.jpdb) };
  r.body = JSON.stringify(body);
  r.timeoutInterval = 20;
  const data = await r.loadJSON();
  if (r.response.statusCode >= 400) throw new Error((data && data.error_message) || 'jpdb ' + r.response.statusCode);
  return data;
}
function stateOf(cs) {
  if (!cs || !cs.length) return 'new';
  const s = (cs[0] === 'redundant' || cs[0] === 'locked') ? (cs[1] || cs[0]) : cs[0];
  return s;
}
function shortMeaning(chunks) {
  const first = (chunks && chunks[0] && chunks[0][0]) || '';
  return first.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/;|,(?![^(]*\))/)[0].trim();
}
// Same three words all day; new ones tomorrow. Words that are due or failed come first, then ones you are learning.
function pickForToday(list) {
  let seed = 0; for (const ch of TODAY) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rank = { due: 0, failed: 0, learning: 1, new: 2 };
  const pool = list.filter((w) => w.state in rank).sort((a, b) => rank[a.state] - rank[b.state]);
  const out = [];
  for (const tier of [0, 1, 2]) {
    const t = pool.filter((w) => rank[w.state] === tier);
    while (t.length && out.length < 3) out.push(t.splice(Math.floor(rnd() * t.length), 1)[0]);
    if (out.length === 3) break;
  }
  return out;
}
async function loadWords() {
  const saved = cache.read('words.json');
  if (saved && saved.day === TODAY) return saved.words;
  if (!getKey(KC.jpdb)) return saved ? saved.words : null;
  try {
    const decks = (await jpdb('list-user-decks', { fields: ['id'] })).decks.map((d) => d[0]);
    const seen = new Set(), ids = [];
    for (const id of decks) {
      const v = await jpdb('deck/list-vocabulary', { id, fetch_occurences: false });
      for (const [vid, sid] of v.vocabulary || []) { const k = vid + '/' + sid; if (!seen.has(k)) { seen.add(k); ids.push([vid, sid]); } }
    }
    const list = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const r = await jpdb('lookup-vocabulary', { list: part, fields: ['spelling', 'reading', 'meanings_chunks', 'card_state'] });
      (r.vocabulary_info || []).forEach((info) => {
        if (!info) return;
        list.push({ spelling: info[0], reading: info[1], meaning: shortMeaning(info[2]), state: stateOf(info[3]) });
      });
    }
    const words = pickForToday(list);
    cache.write('words.json', { day: TODAY, words });
    return words;
  } catch (e) {
    return saved ? saved.words : null;
  }
}

// ---------- drawing ----------
function mix(pct) { // #EDEDEC over #0C0C0D at pct%
  const a = [0x0C, 0x0C, 0x0D], b = [0xED, 0xED, 0xEC];
  const hex = a.map((v, i) => Math.round(v + (b[i] - v) * pct / 100).toString(16).padStart(2, '0')).join('');
  return new Color('#' + hex);
}
// Five steps: under 30m, under 1h, under 2h, under 3h, 3h or more. Same as the Hibi calendar.
const shade = (m) => !m ? 0 : m < 30 ? 7 : m < 60 ? 13 : m < 120 ? 20 : m < 180 ? 28 : 37;

function text(stack, str, font, color, opts = {}) {
  const t = stack.addText(str);
  t.font = font; t.textColor = color;
  if (opts.lines) t.lineLimit = opts.lines;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}

function build(entries, words) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(16, 16, 14, 16);
  w.url = HIBI_URL;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  // practice minutes and finished things per day
  const mins = {}, fin = {};
  for (const e of entries || []) {
    if (PRACTICE.includes(e.c)) mins[e.d] = (mins[e.d] || 0) + (e.m || 0);
    else if (FINISHED.includes(e.c) && !e.u) fin[e.d] = true;
  }

  const top = w.addStack();
  top.layoutHorizontally();

  // left: today
  const left = top.addStack();
  left.layoutVertically();
  left.size = new Size(104, 0);
  text(left, MONTHS[today.getMonth()], Font.semiboldSystemFont(15), C.ink2);
  left.addSpacer(2);
  text(left, String(today.getDate()), Font.boldSystemFont(today.getDate() > 9 ? 92 : 132), C.ink, { lines: 1, scale: 0.5 });
  text(left, DAYS[today.getDay()], Font.semiboldSystemFont(15), C.ink);
  left.addSpacer();

  top.addSpacer(12);

  // right: the month
  const cal = top.addStack();
  cal.layoutVertically();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const rows = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
  const cw = 29, ch = rows > 5 ? 30 : 35, gap = 2;

  const head = cal.addStack();
  for (const [i, l] of ['M', 'T', 'W', 'T', 'F', 'S', 'S'].entries()) {
    const c = head.addStack(); c.size = new Size(cw, 14); c.centerAlignContent();
    text(c, l, Font.semiboldSystemFont(9), C.muted);
    if (i < 6) head.addSpacer(gap);
  }
  cal.addSpacer(3);

  for (let r = 0; r < rows; r++) {
    const row = cal.addStack();
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + r * 7 + i);
      const k = key(d), inMonth = d.getMonth() === today.getMonth();
      const c = row.addStack();
      c.size = new Size(cw, ch);
      c.cornerRadius = 7;
      c.layoutVertically();
      c.centerAlignContent();
      const s = shade(mins[k]);
      if (s) c.backgroundColor = mix(s);
      if (k === TODAY) { c.borderWidth = 1.5; c.borderColor = C.ink; }
      c.addSpacer();
      const line = c.addStack(); line.addSpacer();
      text(line, String(d.getDate()), k === TODAY ? Font.boldSystemFont(12) : Font.systemFont(12), inMonth ? C.ink : C.muted);
      line.addSpacer();
      const dotRow = c.addStack(); dotRow.size = new Size(cw, 6); dotRow.addSpacer();
      if (fin[k]) { const dot = dotRow.addStack(); dot.size = new Size(3, 3); dot.cornerRadius = 1.5; dot.backgroundColor = C.ink; }
      dotRow.addSpacer();
      c.addSpacer();
      if (i < 6) row.addSpacer(gap);
    }
    if (r < rows - 1) cal.addSpacer(gap);
  }

  w.addSpacer();

  // bottom: words
  const rule = w.addStack(); rule.size = new Size(0, 1); rule.backgroundColor = C.hair;
  const ruleFill = rule.addStack(); ruleFill.addSpacer();
  w.addSpacer(10);
  const wordsRow = w.addStack();
  wordsRow.url = YOMU_URL;
  if (words && words.length) {
    words.forEach((wd, i) => {
      const s = wordsRow.addStack();
      s.layoutVertically();
      s.size = new Size(100, 0);
      const showReading = wd.reading && wd.reading !== wd.spelling;
      text(s, showReading ? wd.reading : ' ', MINCHO(9), C.muted, { lines: 1, scale: 0.7 });
      text(s, wd.spelling, MINCHO(24, false), C.ink, { lines: 1, scale: 0.5 });
      text(s, wd.meaning, Font.systemFont(11), C.ink2, { lines: 1, scale: 0.8 });
      if (i < words.length - 1) wordsRow.addSpacer(12);
    });
  } else {
    text(wordsRow, getKey(KC.jpdb) ? 'Words will appear when jpdb can be reached.' : 'Open Scriptable and run this script to add your jpdb key.', Font.systemFont(12), C.muted);
  }
  wordsRow.addSpacer();

  if (!entries) {
    w.addSpacer(6);
    text(w, getKey(KC.gh) ? 'Practice will appear once Hibi has synced.' : 'Open Scriptable and run this script to add your GitHub key.', Font.systemFont(10), C.muted);
  }
  return w;
}

// ---------- run ----------
if (config.runsInApp && (!getKey(KC.gh) || !getKey(KC.jpdb) || args.queryParameters.keys)) {
  await askKeys();
} else if (config.runsInApp) {
  const a = new Alert();
  a.title = 'Hibi widget';
  a.addAction('Preview widget');
  a.addAction('Change keys');
  a.addAction('Refresh words');
  a.addCancelAction('Close');
  const pick = await a.present();
  if (pick === 1) await askKeys();
  if (pick === 2) { const p = fm.joinPath(dir, 'words.json'); if (fm.fileExists(p)) fm.remove(p); }
  var closed = pick === -1;
}

if (typeof closed === 'undefined' || !closed) {
  const [entries, words] = await Promise.all([loadEntries(), loadWords()]);
  const widget = build(entries, words);
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentLarge();
}
Script.complete();
