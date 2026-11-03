// Hibi widget for Scriptable — large size.
// Left: today. Right: this month, shaded by Japanese practice time, with a dot when you finished something.
// Bottom: three words to review from your jpdb decks, new ones each day.
// Run it once inside Scriptable to save your GitHub key (same as Hibi) and your jpdb key (same as Yomu).
//
// Home Screen widgets only get a few seconds to load, so the widget itself never reads your jpdb decks.
// Your word list is saved on the phone whenever you open this script in Scriptable, and the widget picks
// today's three words from that saved list. Practice comes from the Hibi Gist, with a short time limit.
const VERSION = '2026-11-04.2';
const SCRIPT_URL = 'https://raw.githubusercontent.com/zeliavibecodes/Hibi/main/widget/hibi-widget.js';

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
  r.timeoutInterval = config.runsInWidget ? 6 : 15;
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
    if (f.truncated) { const rr = new Request(f.raw_url); rr.timeoutInterval = config.runsInWidget ? 6 : 15; text = await rr.loadString(); }
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
// Reads every deck from jpdb and saves the word list on the phone. Only runs inside the Scriptable app.
async function refreshVocab() {
  if (!getKey(KC.jpdb)) return false;
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
        const st = stateOf(info[3]);
        if (st === 'due' || st === 'failed' || st === 'learning' || st === 'new') list.push({ s: info[0], r: info[1], m: shortMeaning(info[2]), st });
      });
    }
    cache.write('vocab.json', { at: Date.now(), list });
    const p = fm.joinPath(dir, 'words.json'); if (fm.fileExists(p)) fm.remove(p);
    return true;
  } catch (e) {
    return false;
  }
}
// No network: today's three words come from the saved list.
function loadWords() {
  const saved = cache.read('words.json');
  if (saved && saved.day === TODAY) return saved.words;
  const vocab = cache.read('vocab.json');
  if (!vocab || !vocab.list.length) return saved ? saved.words : null;
  const words = pickForToday(vocab.list.map((w) => ({ spelling: w.s, reading: w.r, meaning: w.m, state: w.st })));
  cache.write('words.json', { day: TODAY, words });
  return words;
}

// Replaces this script with the newest version from GitHub, so changes reach the phone without re-saving the file.
async function selfUpdate() {
  try {
    const r = new Request(SCRIPT_URL + '?t=' + Date.now()); r.timeoutInterval = 10;
    const code = await r.loadString();
    const m = code.match(/const VERSION = '([^']+)'/);
    if (!m || m[1] === VERSION || r.response.statusCode !== 200) return false;
    const f = FileManager.iCloud().fileExists(module.filename) ? FileManager.iCloud() : FileManager.local();
    f.writeString(module.filename, code);
    return true;
  } catch (e) { return false; }
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
    text(wordsRow, getKey(KC.jpdb) ? 'Open Scriptable and run Hibi once to load your words.' : 'Open Scriptable and run Hibi to add your jpdb key.', Font.systemFont(12), C.muted);
  }
  wordsRow.addSpacer();

  if (!entries) {
    w.addSpacer(6);
    text(w, getKey(KC.gh) ? 'Practice will appear once Hibi has synced.' : 'Open Scriptable and run this script to add your GitHub key.', Font.systemFont(10), C.muted);
  }
  return w;
}

// ---------- run ----------
if (config.runsInWidget) {
  // Practice from the Gist, but never wait more than 8 seconds; fall back to the saved copy.
  const entries = await Promise.race([loadEntries(), new Promise((res) => Timer.schedule(8000, false, () => res(cache.read('entries.json'))))]);
  Script.setWidget(build(entries, loadWords()));
  Script.complete();
} else {
  if (await selfUpdate()) {
    const u = new Alert(); u.title = 'Hibi widget updated'; u.message = 'Run the script again to use the new version.'; u.addAction('OK'); await u.present();
    Script.complete();
  } else {
    if (!getKey(KC.gh) || !getKey(KC.jpdb)) await askKeys();
    const a = new Alert();
    a.title = 'Hibi widget';
    a.message = 'Version ' + VERSION;
    a.addAction('Preview widget');
    a.addAction('Change keys');
    a.addCancelAction('Close');
    const pick = await a.present();
    if (pick === 1) await askKeys();
    if (pick !== -1) {
      await refreshVocab();
      const entries = await loadEntries();
      await build(entries, loadWords()).presentLarge();
    }
    Script.complete();
  }
}
