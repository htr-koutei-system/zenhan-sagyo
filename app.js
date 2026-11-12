// 前半工程 作業入力（画面側）。GASの1往復は1〜3秒かかるため、操作は手元で先に表示し、送信は裏で順番に行う（後半工程アプリと同じ）。
// 電波が切れたら「送信待ち」で持ち、つながったら同じ送信IDで送り直す（サーバーは同じ送信IDを二重に記録しない）。

const API_URL = window.APP_CONFIG.API_URL;
const APP_VER = 2;                    // 画面の版。サーバーの WORK.MIN_CLIENT_VER 以上にする。上げたら index.html の ?v= も変える
const IDLE_MS = 60 * 60 * 1000;       // 操作がないまま1時間でログアウト
const TIMEOUT_MS = 30000;
const RETRY_MS = 15000;               // 送信待ちを送り直す間隔
const LIST_MS = 60000;                // 一覧・全体の進み具合を読み直す間隔
const Q = new URLSearchParams(location.search);
const MONITOR = Q.get('mode') === 'monitor';      // 大型モニター: 記録するときにログインを聞き、最後の記録から30分でログアウト
const MONITOR_HOLD_MS = 30 * 60 * 1000;
const BOARD_ONLY = Q.get('board') === '1';
const PROC_CODES = ['MOLD', 'CUT', 'SAND', 'BOND'];
const PROC_JA = { MOLD: '成形', CUT: 'カット', SAND: 'サンディング', BOND: '接着' };
const FIX_PROC = normProc(Q.get('proc'));
const FIX_MACHINE = Q.get('machine') || '';
const MACHINES = ['1号機', '3号機', '5号機', 'レーザー', '手切り'];
const MACHINE_T = {
  '1号機': ['1号機', 'No.1', 'No.1', 'Nº 1', 'Nº 1'], '3号機': ['3号機', 'No.3', 'No.3', 'Nº 3', 'Nº 3'],
  '5号機': ['5号機', 'No.5', 'No.5', 'Nº 5', 'Nº 5'], 'レーザー': ['レーザー', 'Laser', 'Laser', 'Laser', 'Láser'],
  '手切り': ['手切り', 'Hand cut', 'Hiwa sa kamay', 'Corte manual', 'Corte manual'],
};

const S = {
  token: '', user: null, settings: null, lang: 'ja', proc: '', machine: FIX_MACHINE,
  rows: [], today: '', listAt: '', queue: [], sending: false, view: 'login', board: null, offline: false,
  lastAct: Date.now(), timers: {}, monitorUntil: 0,
  jump: null, hl: null, bq: '', bf: 'all',
};
const NARROW = window.matchMedia('(max-width: 760px)');
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normProc(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const up = s.toUpperCase();
  if (PROC_CODES.indexOf(up) >= 0) return up;
  const hit = Object.keys(PROC_JA).find(k => PROC_JA[k] === s);
  return hit || '';
}

// ---------- 保存 ----------
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function saveSession() {
  if (MONITOR) return;
  if (S.token) lsSet('zw_session', { token: S.token, user: S.user, proc: S.proc, at: Date.now() });
  else lsDel('zw_session');
}
function saveQueue() { lsSet('zw_queue', S.queue.map(q => ({ rid: q.rid, action: q.action, data: q.data, token: q.token, label: q.label, at: q.at, monitor: q.monitor }))); }

// ---------- 言葉 ----------
function li() { const i = window.LANG_ORDER.indexOf(S.lang); return i < 0 ? 0 : i; }
function t(key) { const a = window.I18N[key]; return a ? (a[li()] || a[0]) : key; }
function optT(o) { return o && o.t ? (o.t[S.lang] || o.t.ja) : ''; }
function procName(code) {
  const p = S.settings && S.settings.processes.find(x => x.code === code);
  return p && p.t ? (p.t[S.lang] || p.t.ja) : (PROC_JA[code] || code);
}
function machineName(m) { const a = MACHINE_T[m]; return a ? a[li()] : m; }
function stName(st) { return t('st_' + st); }

// ---------- 通信 ----------
function device() {
  if (MONITOR) return '大型モニター';
  return /iPad|iPhone|Android|Mobile/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'タブレット・スマホ' : 'パソコン';
}

async function api(action, data, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let j;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action: action, token: token === undefined ? S.token : token, ver: APP_VER, device: device() }, data || {})),
      signal: ctrl.signal,
    });
    j = await res.json();
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? '通信がタイムアウトしました' : '通信できません。電波を確認してください');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!j.stale) { try { sessionStorage.removeItem('zw_reload'); } catch (e) {} }
  if (!j.ok) {
    if (j.stale) {
      let tried = false;
      try { tried = sessionStorage.getItem('zw_reload') === '1'; sessionStorage.setItem('zw_reload', '1'); } catch (e) {}
      if (!tried) location.reload();
    }
    const err = new Error(j.error);
    err.auth = j.auth;
    err.code = j.code;
    throw err;
  }
  return j;
}

async function getBoard() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL + '?action=board', { signal: ctrl.signal });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

let toastTimer = null;
function toast(msg, ng) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (ng ? ' ng' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ng ? 6000 : 2500);
}
function loading(on) { $('loading').classList.toggle('hidden', !on); }

// ---------- 音（インベーダーゲームのショット音のような電子音。音声ファイルは使わない） ----------
let audioCtx = null;
function sound(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const beep = (f0, f1, start, dur, vol, type) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(f0, now + start);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, now + start + dur);
      g.gain.setValueAtTime(vol, now + start);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(now + start); o.stop(now + start + dur + 0.02);
    };
    if (kind === 'shot') { beep(1500, 160, 0, 0.17, 0.11); beep(3000, 320, 0, 0.12, 0.03); }
    else if (kind === 'done') { beep(1500, 160, 0, 0.17, 0.11); beep(1700, 200, 0.12, 0.2, 0.09); }
    else if (kind === 'warn') { beep(880, 880, 0, 0.12, 0.08); beep(880, 880, 0.2, 0.12, 0.08); }
    else if (kind === 'ng') { beep(180, 120, 0, 0.45, 0.12, 'sawtooth'); }
  } catch (e) {}
}

// ---------- 画面の切り替え ----------
function setBar() {
  const bar = $('bar');
  bar.classList.toggle('hidden', S.view === 'login' && !MONITOR);
  $('bar-title').textContent = BOARD_ONLY ? t('board') : t('appName');
  const p = S.proc;
  // 担当の工程が2つ以上なら、ログアウトせずに切り替えられるタブを出す（URLで工程を固定した端末は出さない）
  const tabs = FIX_PROC ? [] : (S.user ? S.user.procs : (MONITOR ? PROC_CODES : []));
  if (S.view === 'list' && tabs.length > 1) {
    $('bar-proc').innerHTML = '<span class="proc-tabs">' + tabs.map(c => '<button class="sm' + (c === p ? ' on' : '') + '" data-tab="' + c + '" style="' +
      (c === p ? 'background:var(--' + c + ');border-color:var(--' + c + ');color:var(--bg)' : 'border-color:var(--' + c + ');color:var(--' + c + ')') + '">' + esc(procName(c)) + '</button>').join('') + '</span>';
    document.querySelectorAll('#bar-proc button[data-tab]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tab === S.proc) return;
      touchAct();
      S.proc = b.dataset.tab; S.rows = []; S.listAt = '';
      if (S.proc !== 'CUT') S.machine = FIX_MACHINE;
      saveSession(); show('list'); loadList();
    }));
  } else {
    $('bar-proc').innerHTML = p && S.view !== 'board' ? '<span class="proc-tag clip" style="background:var(--' + p + ')">' + esc(procName(p)) + '</span>' : '';
  }
  $('bar-user').textContent = S.user ? S.user.name : '';
  $('btn-board').textContent = S.view === 'board' ? t('back') : t('board');
  $('btn-board').classList.toggle('hidden', BOARD_ONLY);
  $('btn-lang').textContent = t('lang');
  $('btn-refresh').textContent = t('refresh');
  $('btn-logout').textContent = t('logout');
  $('btn-logout').classList.toggle('hidden', !S.token || BOARD_ONLY);
  updatePending();
  document.documentElement.lang = S.lang;
}

function updatePending() {
  const el = $('bar-pending');
  el.classList.toggle('hidden', !S.queue.length);
  el.textContent = t('pending') + ' ' + S.queue.length;
}

function show(view) {
  S.view = view;
  $('view').classList.toggle('wide', view === 'board');
  clearInterval(S.timers.list);
  clearInterval(S.timers.board);
  if (view === 'login') renderLogin();
  else if (view === 'procs') renderProcs();
  else if (view === 'list') { renderList(); S.timers.list = setInterval(() => { if (!S.queue.length && !modalOpen()) loadList(true); }, LIST_MS); }
  else if (view === 'board') { renderBoard(); loadBoard(); S.timers.board = setInterval(loadBoard, LIST_MS); }
  setBar();
}

// ---------- ログイン ----------
function keypadMode() { return lsGet('zw_keypad') !== false; }

function loginForm(idPrefix, title) {
  const kp = keypadMode();
  return '<div class="sub">' + esc(title || '') + '</div>' +
    '<label for="' + idPrefix + 'emp">' + esc(t('emp')) + '</label>' +
    '<input id="' + idPrefix + 'emp" type="' + (kp ? 'text' : 'tel') + '" autocomplete="off" ' + (kp ? 'inputmode="none" readonly' : 'inputmode="numeric"') + '>' +
    '<label for="' + idPrefix + 'pin">' + esc(t('pin')) + '</label>' +
    '<input id="' + idPrefix + 'pin" type="password" autocomplete="off" ' + (kp ? 'inputmode="none" readonly' : 'inputmode="numeric"') + '>' +
    (kp ? '<div class="keypad">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => '<button data-k="' + n + '">' + n + '</button>').join('') +
      '<button data-k="C" class="danger">' + esc(t('clear')) + '</button><button data-k="0">0</button><button data-k="OK" class="primary">' + esc(t('ok')) + '</button></div>' : '') +
    '<div class="row"><button id="' + idPrefix + 'mode" class="accent sm">' + esc(kp ? t('keyboard') : t('tenkey')) + '</button>' +
    (kp ? '' : '<button id="' + idPrefix + 'go" class="primary">' + esc(t('login')) + '</button>') + '</div>' +
    '<div class="err" id="' + idPrefix + 'err"></div>';
}

/** ログインの入力欄の動き（テンキー・キーボード、Tab・Enter・Esc）。onSubmit(emp, pin) */
function wireLogin(idPrefix, onSubmit, onEsc) {
  const emp = $(idPrefix + 'emp'), pin = $(idPrefix + 'pin');
  let focus = emp;
  const kp = keypadMode();
  const mark = () => { [emp, pin].forEach(x => { x.style.borderColor = x === focus ? 'var(--line)' : ''; }); };
  [emp, pin].forEach(x => { x.addEventListener('focus', () => { focus = x; mark(); }); x.addEventListener('pointerdown', () => { focus = x; mark(); }); });
  const submit = () => {
    if (!emp.value.trim()) { focus = emp; emp.focus(); mark(); return; }
    if (!pin.value.trim()) { focus = pin; pin.focus(); mark(); return; }
    onSubmit(emp.value.trim(), pin.value.trim());
  };
  if (kp) {
    document.querySelectorAll('.keypad button').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (k === 'C') focus.value = '';
      else if (k === 'OK') { if (focus === emp && emp.value) { focus = pin; mark(); } else submit(); }
      else if (focus.value.length < 12) focus.value += k;
    }));
  } else {
    $(idPrefix + 'go').addEventListener('click', submit);
  }
  [emp, pin].forEach(x => x.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (x === emp) { focus = pin; pin.focus(); mark(); } else submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (x.value) x.value = ''; else if (onEsc) onEsc(); }
  }));
  // テンキーでもパソコンのキーボードの数字は効くようにする
  if (kp) {
    const onKey = e => {
      if (!document.body.contains(emp)) { document.removeEventListener('keydown', onKey); return; }
      if (e.target === emp || e.target === pin) {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); if (e.target.value.length < 12) e.target.value += e.key; }
        else if (e.key === 'Backspace') { e.preventDefault(); e.target.value = e.target.value.slice(0, -1); }
        else if (e.key === 'Tab') { e.preventDefault(); focus = e.target === emp ? pin : emp; focus.focus(); mark(); }
      }
    };
    document.addEventListener('keydown', onKey);
  }
  $(idPrefix + 'mode').addEventListener('click', () => { lsSet('zw_keypad', !kp); if (idPrefix === 'l-') renderLogin(); else S.relogin && S.relogin(); });
  emp.focus();
  mark();
  // ログインに失敗したとき: 暗証番号だけ消す／両方消して社員番号から
  return {
    retryPin: () => { pin.value = ''; focus = pin; mark(); pin.focus(); },
    reset: () => { emp.value = ''; pin.value = ''; focus = emp; mark(); emp.focus(); },
  };
}

function langButtons() {
  return '<div class="langs">' + window.LANG_ORDER.map(l => '<button data-lang="' + l + '" class="sm' + (l === S.lang ? ' on' : '') + '">' + esc(window.LANG_NAMES[l]) + '</button>').join('') + '</div>';
}

function renderLogin(msg) {
  $('view').innerHTML = '<div class="login clip"><div class="stripe"></div><h1>' + esc(t('appName')) + '</h1>' +
    (S.jump ? '<div class="sub jumpnote">' + esc(t('loginToOpen')) + '：' + esc(procName(S.jump.proc)) + '</div>' : '') +
    loginForm('l-') + langButtons() +
    '<div class="row"><button id="l-board" class="sm">' + esc(S.jump ? t('back') : t('board')) + '</button></div></div>';
  S.loginCtl = wireLogin('l-', doLogin);
  $('l-board').addEventListener('click', () => { S.jump = null; if (!FIX_PROC) S.proc = ''; show('board'); });
  document.querySelectorAll('.langs button').forEach(b => b.addEventListener('click', () => { S.lang = b.dataset.lang; lsSet('zw_lang', S.lang); renderLogin(); setBar(); }));
  if (msg) $('l-err').textContent = msg;
}

async function doLogin(emp, pin) {
  $('l-err').textContent = '';
  loading(true);
  try {
    const j = await api('login', { emp: emp, pin: pin }, '');
    afterLogin(j);
  } catch (e) {
    sound('ng');
    $('l-err').textContent = e.message;
    if (e.code === 'noproc') S.loginCtl.reset(); else S.loginCtl.retryPin();
  } finally {
    loading(false);
  }
}

function afterLogin(j) {
  S.token = j.token;
  S.user = j.user;
  S.settings = pickSettings(j);
  lsSet('zw_settings', S.settings);
  if (j.user.lang) S.lang = j.user.lang;
  S.lastAct = Date.now();
  const procs = S.user.procs;
  if (S.jump && procs.indexOf(S.jump.proc) < 0) { toast(t('notAssigned') + '：' + procName(S.jump.proc), true); S.jump = null; }
  if (S.jump) S.proc = S.jump.proc;
  else if (FIX_PROC && procs.indexOf(FIX_PROC) >= 0) S.proc = FIX_PROC;
  else if (S.proc && procs.indexOf(S.proc) >= 0) { /* そのまま */ }
  else S.proc = procs.length === 1 ? procs[0] : '';
  saveSession();
  if (S.proc) { show('list'); loadList(); } else show('procs');
}

function pickSettings(j) { return { processes: j.processes, defects: j.defects, stops: j.stops, changeItems: j.changeItems }; }

async function logout(msg) {
  const token = S.token;
  S.token = ''; S.user = null;
  saveSession();
  if (token && !S.queue.some(q => q.token === token)) api('logout', {}, token).catch(() => {});
  if (MONITOR) { S.lang = lsGet('zw_lang') || 'ja'; S.monitorUntil = 0; show('list'); loadList(); return; }
  if (!FIX_PROC) S.proc = '';
  show('login');
  if (msg) $('l-err').textContent = msg;
}

// ---------- 工程を選ぶ ----------
function renderProcs() {
  const codes = S.user ? S.user.procs : PROC_CODES;
  $('view').innerHTML = '<h2 class="sec">' + esc(t('chooseProc')) + '</h2><div class="procs">' +
    codes.map(c => '<button data-p="' + c + '" style="border-color:var(--' + c + ');color:var(--' + c + ')">' + esc(procName(c)) + '</button>').join('') + '</div>';
  document.querySelectorAll('.procs button').forEach(b => b.addEventListener('click', () => {
    S.proc = b.dataset.p; S.rows = []; saveSession(); show('list'); loadList();
  }));
}

// ---------- 一覧 ----------
async function loadList(silent) {
  if (!S.proc) return;
  if (!silent) loading(true);
  try {
    const j = await api('list', { proc: S.proc }, S.token);
    S.rows = j.rows; S.today = j.today; S.listAt = j.at; S.offline = false;
    lsSet('zw_rows_' + S.proc, { rows: j.rows, today: j.today, at: j.at });
    if (S.jump && S.jump.proc === S.proc) applyJump();
    if (S.view === 'list') { renderList(); scrollToHl(); }
  } catch (e) {
    if (e.auth) { logout(e.message); return; }
    if (!silent) toast(e.message, true);
    if (e.network && !S.rows.length) {
      const c = lsGet('zw_rows_' + S.proc);
      if (c) { S.rows = c.rows; S.today = c.today; S.listAt = c.at; if (S.view === 'list') renderList(); }
    }
  } finally {
    if (!silent) loading(false);
  }
}

/** カット区分の値から号機（NC1→1号機、NC3-5→3号機と5号機、LASER→レーザー、HAND→手切り） */
function machinesOf(v) {
  const s = String(v || '').toUpperCase();
  const out = [];
  const m = s.match(/NC\s*([0-9][0-9\-\/,・ ]*)/);
  if (m) ['1', '3', '5'].forEach(d => { if (m[1].indexOf(d) >= 0) out.push(d + '号機'); });
  s.split(/[\/,・]/).forEach(x => { const n = x.match(/^\s*NC\s*([135])/); if (n && out.indexOf(n[1] + '号機') < 0) out.push(n[1] + '号機'); });
  if (/LASER|レーザー/.test(s)) out.push('レーザー');
  if (/HAND|手切/.test(s)) out.push('手切り');
  return out;
}

function visibleRows() {
  let rows = S.rows.slice();
  if (S.proc === 'CUT' && S.machine) rows = rows.filter(r => machinesOf(r.cutEq).indexOf(S.machine) >= 0);
  return rows;
}

function listMode() { return lsGet('zw_listmode') === 'table' ? 'table' : 'card'; }

/** ボードから来たとき: 該当の行を強調（1分）。号機で絞っていて見えなければ絞り込みを外す */
function applyJump() {
  const id = S.jump.id;
  S.jump = null;
  const r = rowById(id);
  if (!r) { toast(t('notInList'), true); return; }
  if (S.proc === 'CUT' && S.machine && !FIX_MACHINE && machinesOf(r.cutEq).indexOf(S.machine) < 0) S.machine = '';
  S.hl = { id: String(id), until: Date.now() + 60000, scroll: true };
}
function isHl(r) { return S.hl && S.hl.id === String(r.id) && Date.now() < S.hl.until; }
function scrollToHl() {
  if (!S.hl || !S.hl.scroll) return;
  S.hl.scroll = false;
  const el = document.querySelector('[data-row="' + CSS.escape(S.hl.id) + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderList() {
  const rows = visibleRows();
  const today = S.today || '';
  const act = rows.filter(r => r.status !== '完了');
  const now = act.filter(r => !r.date || r.date <= today).sort(cmpRow);
  const fut = act.filter(r => r.date && r.date > today).sort(cmpRow);
  const done = rows.filter(r => r.status === '完了').sort((a, b) => (b.end || '').localeCompare(a.end || ''));
  const mode = listMode();
  let h = '<div class="list-head">';
  if (S.proc === 'CUT') {
    h += '<div class="chips">' + [''].concat(MACHINES).map(m => '<button class="sm' + (S.machine === m ? ' on' : '') + '" data-m="' + esc(m) + '"' +
      (FIX_MACHINE ? ' disabled' : '') + '>' + esc(m ? machineName(m) : t('all')) + '</button>').join('') + '</div>';
  }
  h += '<div class="chips view-mode"><button class="sm' + (mode === 'card' ? ' on' : '') + '" data-vm="card">' + esc(t('viewCard')) + '</button>' +
    '<button class="sm' + (mode === 'table' ? ' on' : '') + '" data-vm="table">' + esc(t('viewTable')) + '</button></div></div>';
  const sec = (title, list) => '<h2 class="sec">' + esc(title) + ' (' + list.length + ')</h2>' +
    (!list.length ? '<div class="empty">' + esc(t('none')) + '</div>' :
      mode === 'table' ? '<div class="tablewrap"><table class="list"><thead><tr><th>' + esc(t('colStatus')) + '</th><th>' + esc(t('order')) + '</th><th>' +
        esc(t('colItem')) + '</th><th>' + esc(t('colQty')) + '</th><th>' + esc(t('colStart')) + '</th><th></th></tr></thead><tbody>' + list.map(trow).join('') + '</tbody></table></div>' :
        '<div class="cards">' + list.map(card).join('') + '</div>');
  h += sec(t('todayLate'), now) + sec(t('future'), fut) + sec(t('doneRecent'), done);
  h += '<div class="note">' + esc(t('updated')) + ' ' + esc(S.listAt) + (S.token || !MONITOR ? '' : ' ／ ' + esc(t('loginEach'))) + '</div>';
  if (!S.proc) h = '';
  $('view').innerHTML = h;
  document.querySelectorAll('.chips button[data-m]').forEach(b => b.addEventListener('click', () => { S.machine = b.dataset.m; renderList(); }));
  document.querySelectorAll('.chips button[data-vm]').forEach(b => b.addEventListener('click', () => { lsSet('zw_listmode', b.dataset.vm); renderList(); }));
  document.querySelectorAll('#view button[data-act]').forEach(b => b.addEventListener('click', () => onAction(b.dataset.act, b.dataset.id, b)));
}

function cmpRow(a, b) {
  const st = r => (r.status === '作業中' ? 0 : 1);
  return st(a) - st(b) || (a.date || '').localeCompare(b.date || '') || String(a.order).localeCompare(String(b.order)) || Number(a.id) - Number(b.id);
}

/** 成形で 材料寸法・材料ID が空いている項目（変更画面の項目キー） */
function missingMat(r) {
  if (S.proc !== 'MOLD' || r.status === '完了') return [];
  return ['size', 'matId'].filter(k => !String(r[k] || '').trim());
}

/** カード・表で共通の部品 */
function parts(r) {
  const p = S.proc;
  const pend = S.queue.some(q => q.data.id === r.id && q.data.proc === p);
  const viewOnly = S.user && !S.user.input;   // 閲覧の人は見るだけ（ボタンを出さない）
  const btn = (act, label, cls) => '<button data-act="' + act + '" data-id="' + esc(r.id) + '" class="' + (cls || '') + '"' + (pend ? ' disabled' : '') + '>' + esc(label) + '</button>';
  const dateTag = r.status === '完了' ? '' : r.late ? '<span class="tag late">' + esc(t('late')) + '</span>' : (r.date === S.today ? '<span class="tag today">' + esc(t('today')) + '</span>' : '');
  const meta = [];
  if (p === 'MOLD') { if (r.size) meta.push(t('size') + ' <b>' + esc(r.size) + '</b>'); if (r.moldEq) meta.push(t('moldEq') + ' <b>' + esc(r.moldEq) + '</b>'); }
  if (p === 'CUT') { if (r.cutEq) meta.push(t('cutEq') + ' <b>' + esc(r.cutEq) + '</b>'); if (r.jig) meta.push(t('jig') + ' <b>' + esc(r.jig) + '</b>'); }
  if (p === 'SAND' && r.material) meta.push(esc(r.material));
  if (r.matId) meta.push(esc(r.matId));
  const miss = missingMat(r);
  const mat = miss.length ? '<div class="matwarn"><span>' + esc(t('noMaterial')) + '（' + miss.map(k => esc(t(k))).join('・') + '）</span>' +
    (viewOnly ? '' : btn('fixmat', t('fixMaterial'), 'danger sm')) + '</div>' : '';
  let prev = '';
  if (r.prev) {
    if (r.prev.diff !== null && r.prev.diff !== undefined) {
      const d = r.prev.diff;
      prev = esc(t('prevGood')) + '（' + esc(procName(r.prev.proc)) + '） <b>' + r.prev.good + '</b> <span class="diff ' + (d < 0 ? 'minus' : d > 0 ? 'plus' : 'zero') + '">' + (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d) + '</span>';
    } else {
      prev = esc(t('prevProc')) + '（' + esc(procName(r.prev.proc)) + '） ' + esc(stName(r.prev.state || '未着手')) + (r.prev.good ? ' ' + r.prev.good : '');
    }
  }
  const times = [r.start ? t('startAt') + ' ' + esc(r.start === '不明' ? t('unknown') : r.start.slice(5)) : '', r.end ? t('endAt') + ' ' + esc(r.end.slice(5)) : '',
                 r.workers ? t('workers') + ' ' + esc(r.workers) : ''].filter(Boolean).join('　');
  const canChange = p === 'MOLD' || p === 'CUT';
  // ボタン: main＝一番大きく、mid＝ふつう、sub＝小さく下へ。完了は開始してから（未着手・中断には出さない）
  let main = '', mid = '', sub = '';
  if (r.status === '作業中') {
    main = btn('complete', t('complete'), 'primary big');
    mid = btn('interrupt', t('interrupt'), 'accent') + (!r.mine && S.token ? btn('join', t('join')) : '');
    sub = canChange ? btn('change', t('change'), 'sm') : '';
  } else if (r.status === '完了') {
    if ((MONITOR && !S.token) || (r.undo && r.undo.ok)) mid = btn('undo', t('undo'), 'danger');
  } else {
    main = btn('start', t('start'), 'primary big');
    sub = canChange ? btn('change', t('change'), 'sm') : '';
  }
  if (viewOnly) main = mid = sub = '';
  return { pend: pend, dateTag: dateTag, meta: meta, mat: mat, prev: prev, times: times, main: main, mid: mid, sub: sub };
}

function card(r) {
  const p = S.proc;
  const x = parts(r);
  const qty = '<div class="qty"><span>' + esc(t('planned')) + ' <span class="big">' + r.qty + '</span></span>' +
    (r.remain !== r.qty && r.status !== '完了' ? '<span>' + esc(t('remain')) + ' <span class="big">' + r.remain + '</span></span>' : '') +
    (r.status === '完了' ? '<span>' + esc(t('good')) + ' <span class="big">' + r.good + '</span></span>' : '') +
    (x.prev ? '<span>' + x.prev + '</span>' : '') + '</div>';
  const sc = p === 'BOND' && r.sc ? '<div class="meta">' + esc(t('sc')) + ': ' + esc(String(r.sc).replace(/\n/g, ' / ')) + '</div>' : '';
  const acts = (x.main ? '<div class="actions main">' + x.main + '</div>' : '') + (x.mid ? '<div class="actions">' + x.mid + '</div>' : '') +
    (x.sub ? '<div class="actions sub">' + x.sub + '</div>' : '');
  return '<div class="card clip st-' + esc(r.status) + (isHl(r) ? ' hl' : '') + '" data-row="' + esc(r.id) + '"><div class="pbar" style="background:var(--' + p + ')"></div>' +
    '<div class="top"><span class="tag st st-' + esc(r.status) + '">' + esc(stName(r.status)) + '</span>' + x.dateTag +
    '<span>' + esc(r.date) + '</span><span>' + esc(t('order')) + ' ' + esc(r.order) + '</span>' + (x.pend ? '<span class="pending">' + esc(t('pending')) + '</span>' : '') + '</div>' +
    '<div class="pno">' + esc(r.pno) + '</div><div class="name">' + esc([r.maker, r.car, r.part].filter(Boolean).join(' ／ ')) + '</div>' +
    x.mat + (x.meta.length ? '<div class="meta">' + x.meta.join('　') + '</div>' : '') + sc + qty +
    (x.times ? '<div class="meta">' + x.times + '</div>' : '') + (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '') + acts + '</div>';
}

/** 表（1行1件） */
function trow(r) {
  const x = parts(r);
  const qty = r.status === '完了' ? t('good') + ' <b>' + r.good + '</b>／' + r.qty :
    '<b>' + r.remain + '</b>' + (r.remain !== r.qty ? '／' + r.qty : '');
  return '<tr class="st-' + esc(r.status) + (isHl(r) ? ' hl' : '') + '" data-row="' + esc(r.id) + '">' +
    '<td><span class="tag st st-' + esc(r.status) + '">' + esc(stName(r.status)) + '</span> ' + x.dateTag + (x.pend ? ' <span class="pending">' + esc(t('pending')) + '</span>' : '') +
    '<div class="note">' + esc(r.date) + '</div></td>' +
    '<td class="nowrap">' + esc(r.order) + '</td>' +
    '<td><b>' + esc(r.pno) + '</b><div class="name note">' + esc([r.maker, r.car, r.part].filter(Boolean).join(' ／ ')) + '</div>' + x.mat +
    (x.meta.length ? '<div class="note">' + x.meta.join('　') + '</div>' : '') + '</td>' +
    '<td class="nowrap">' + qty + (x.prev ? '<div class="note">' + x.prev + '</div>' : '') + '</td>' +
    '<td class="note">' + x.times + '</td>' +
    '<td class="tacts">' + x.main.replace('primary big', 'primary') + x.mid + x.sub + '</td></tr>';
}

function rowById(id) { return S.rows.find(r => String(r.id) === String(id)); }

// ---------- 操作 ----------
let undoArm = null;
function onAction(act, id, btn) {
  touchAct();
  const r = rowById(id);
  if (!r) return;
  if (act === 'undo' && S.token) {
    if (undoArm !== id) {
      undoArm = id;
      btn.textContent = t('undoConfirm');
      setTimeout(() => { if (undoArm === id) { undoArm = null; renderList(); } }, 4000);
      return;
    }
    undoArm = null;
  }
  withUser(user => {
    if (act === 'start' || act === 'join') queueOp('start', { proc: S.proc, id: id }, r.pno + ' ' + t('start'), user);
    else if (act === 'complete') openComplete(r, user);
    else if (act === 'interrupt') openInterrupt(r, user);
    else if (act === 'change') openChange(r, user);
    else if (act === 'fixmat') openChange(r, user, missingMat(r)[0]);
    else if (act === 'undo') doUndo(r, user);
  });
}

/** 操作する人。ふだんはログイン中の人。大型モニターは毎回ログインを聞く */
function withUser(fn) {
  if (S.token) {
    if (S.user.procs.indexOf(S.proc) < 0 || !S.user.input) { sound('ng'); toast(S.user.input ? t('needLogin') : t('viewOnly'), true); return; }
    if (MONITOR) S.monitorUntil = Date.now() + MONITOR_HOLD_MS;
    fn({ token: S.token, user: S.user });
    return;
  }
  if (!MONITOR) { show('login'); return; }
  const draw = () => {
    openModal('<h3>' + esc(t('login')) + '</h3>' + loginForm('m-', t('loginEach')) + '<div class="row"><button id="m-cancel">' + esc(t('cancel')) + '</button></div>');
    const ctl = wireLogin('m-', async (emp, pin) => {
      loading(true);
      try {
        const j = await api('login', { emp: emp, pin: pin }, '');
        if (j.user.procs.indexOf(S.proc) < 0 || !j.user.input) {
          api('logout', {}, j.token).catch(() => {});
          const e = new Error(j.user.input ? '「' + procName(S.proc) + '」の担当ではありません' : t('viewOnly'));
          e.code = 'noproc';
          throw e;
        }
        // 大型モニター: ログインしたまま、最後の記録から30分でログアウト
        S.settings = pickSettings(j);
        S.token = j.token; S.user = j.user;
        if (j.user.lang) S.lang = j.user.lang;
        S.monitorUntil = Date.now() + MONITOR_HOLD_MS;
        closeModal();
        setBar();
        fn({ token: j.token, user: j.user, monitor: true });
        loadList(true);
      } catch (e) {
        sound('ng');
        $('m-err').textContent = e.message;
        if (e.code === 'noproc') ctl.reset(); else ctl.retryPin();
      } finally {
        loading(false);
      }
    }, closeModal);
    $('m-cancel').addEventListener('click', closeModal);
  };
  S.relogin = draw;
  draw();
}

function queueOp(action, data, label, who) {
  const item = { rid: uid(), action: action, data: data, token: who.token, label: label, at: Date.now(), monitor: !!who.monitor };
  predict(item, who.user);
  S.queue.push(item);
  saveQueue();
  sound(action === 'complete' ? 'done' : 'shot');
  if (MONITOR) S.monitorUntil = Date.now() + MONITOR_HOLD_MS;
  renderList();
  setBar();
  pump();
}

/** 手元の一覧に先に反映する（サーバーの結果で置き換える） */
function predict(item, user) {
  const r = rowById(item.data.id);
  if (!r) return;
  item.snapshot = JSON.parse(JSON.stringify(r));
  const d = item.data;
  if (item.action === 'start') {
    r.status = '作業中'; r.mine = true;
    if (!r.start) r.start = nowLocal();
    if (user && String(r.workers || '').split('、').indexOf(user.name) < 0) r.workers = [r.workers, user.name].filter(Boolean).join('、');
  } else if (item.action === 'complete') {
    if (d.rest === 'later') { r.status = '未着手'; r.remain = r.remain - Number(d.good); r.qty = r.remain; r.start = ''; r.workers = ''; }
    else { r.status = '完了'; r.good = Number(d.good); r.end = nowLocal(); if (!r.start) r.start = '不明'; }
  } else if (item.action === 'interrupt') {
    r.status = '中断'; r.remain = r.remain - (Number(d.good) || 0); r.qty = r.remain; r.start = ''; r.workers = '';
  } else if (item.action === 'undo') {
    r.status = '作業中'; r.end = ''; r.undo = null;
  } else if (item.action === 'change') {
    r[d.item] = d.value;
  }
}

function nowLocal() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

let pumpTimer = null;
async function pump() {
  if (S.sending) return;
  S.sending = true;
  clearTimeout(pumpTimer);
  while (S.queue.length) {
    const item = S.queue[0];
    let res = null, error = null;
    try {
      res = await api(item.action, Object.assign({ rid: item.rid }, item.data), item.token);
    } catch (e) {
      error = e;
    }
    if (error && error.network) {
      // 電波が無い: 送信待ちのまま持って、あとで同じ送信IDで送り直す
      if (!S.offline) toast(t('offline'), true);
      S.offline = true;
      pumpTimer = setTimeout(pump, RETRY_MS);
      break;
    }
    S.offline = false;
    S.queue.shift();
    saveQueue();
    if (res) {
      if (res.row) mergeRow(res.row, item.data.proc);
      if (res.short) toast(res.short, true);
      else toast(item.label + '：' + t('sent'));
    } else {
      sound('ng');
      toast(t('failed') + '：' + error.message, true);
      if (item.snapshot) mergeRow(item.snapshot, item.data.proc);
      if (error.auth && item.token === S.token) { S.sending = false; logout(error.message); return; }
    }
    updatePending();
    if (S.view === 'list') renderList();
  }
  S.sending = false;
  if (!S.queue.length) loadList(true);
}

function mergeRow(row, proc) {
  if (proc !== S.proc) return;
  const i = S.rows.findIndex(r => String(r.id) === String(row.id));
  if (i >= 0) S.rows[i] = row; else S.rows.push(row);
}

// ---------- 完了 ----------
function numPad() {
  return '<div class="keypad">' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => '<button data-n="' + n + '">' + n + '</button>').join('') +
    '<button data-n="C" class="danger">' + esc(t('clear')) + '</button><button data-n="0">0</button><button data-n="BS">⌫</button></div>';
}
function wireNumPad(inputs) {
  let focus = inputs[0];
  inputs.forEach(x => {
    x.addEventListener('focus', () => { focus = x; inputs.forEach(y => { y.style.borderColor = y === focus ? 'var(--line)' : ''; }); });
    x.addEventListener('input', () => { x.value = x.value.replace(/[^0-9]/g, '').slice(0, 6); });
  });
  document.querySelectorAll('#modal-body .keypad button').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.n;
    if (n === 'C') focus.value = '';
    else if (n === 'BS') focus.value = focus.value.slice(0, -1);
    else if (focus.value.length < 6) focus.value += n;
  }));
  focus.focus();
}

function openComplete(r, who) {
  const p = S.proc;
  const st = { good: '', boards: '' };
  const head = '<h3>' + esc(t('complete')) + '　' + esc(r.pno) + '</h3><div class="sub">' + esc([r.maker, r.car, r.part].filter(Boolean).join(' ／ ')) +
    '　' + esc(t('remain')) + ' ' + r.remain + '</div>';
  const stepQty = () => {
    openModal(head +
      '<label>' + esc(t('good')) + '</label><div class="numbox"><input id="c-good" type="text" inputmode="numeric" autocomplete="off"></div>' +
      (p === 'MOLD' ? '<label>' + esc(t('boards')) + '</label><div class="numbox"><input id="c-boards" type="text" inputmode="numeric" autocomplete="off"></div>' : '') +
      numPad() + '<div class="err" id="c-err"></div><div class="row"><button id="c-cancel">' + esc(t('cancel')) + '</button><button id="c-next" class="primary">' + esc(t('next')) + '</button></div>');
    const inputs = [$('c-good')].concat(p === 'MOLD' ? [$('c-boards')] : []);
    $('c-good').value = st.good !== '' ? st.good : String(r.remain);
    if (p === 'MOLD') $('c-boards').value = st.boards;
    wireNumPad(inputs);
    $('c-good').select();
    $('c-cancel').addEventListener('click', closeModal);
    const next = () => {
      st.good = $('c-good').value.trim();
      if (p === 'MOLD') st.boards = $('c-boards').value.trim();
      if (!/^\d+$/.test(st.good)) { $('c-err').textContent = t('good'); sound('warn'); return; }
      if (p === 'MOLD' && !/^\d+$/.test(st.boards)) { $('c-err').textContent = t('boards'); sound('warn'); $('c-boards').focus(); return; }
      const g = Number(st.good);
      if (g < r.remain) stepRest();
      else if (g > r.remain) stepOver();
      else send({});
    };
    $('c-next').addEventListener('click', next);
    inputs.forEach(x => x.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); next(); } if (e.key === 'Escape') closeModal(); }));
  };
  const stepRest = () => {
    const g = Number(st.good);
    openModal(head + '<h3>' + esc(t('restQ')) + '</h3><div class="sub">' + esc(t('good')) + ' ' + g + ' ／ ' + esc(t('remain')) + ' ' + (r.remain - g) + '</div>' +
      '<div class="choices"><button id="c-scrap" class="danger">' + esc(t('scrap')) + '</button><button id="c-later" class="accent"' + (g === 0 ? ' disabled' : '') + '>' + esc(t('later')) + '</button></div>' +
      '<div class="row"><button id="c-back">' + esc(t('back')) + '</button></div>');
    $('c-back').addEventListener('click', stepQty);
    $('c-scrap').addEventListener('click', stepDefect);
    $('c-later').addEventListener('click', () => send({ rest: 'later' }));
  };
  const stepOver = () => {
    openModal(head + '<h3>' + esc(t('overQ')) + '</h3><div class="sub">' + esc(t('good')) + ' ' + st.good + '（+' + (Number(st.good) - r.remain) + '）</div>' +
      '<div class="row"><button id="c-back">' + esc(t('back')) + '</button><button id="c-ok" class="primary">' + esc(t('record')) + '</button></div>');
    sound('warn');
    $('c-back').addEventListener('click', stepQty);
    $('c-ok').addEventListener('click', () => send({ over: true }));
  };
  const stepDefect = () => {
    const list = (S.settings.defects || {})[p] || [];
    const k = PROC_CODES.indexOf(p);
    const causes = p === 'CUT' || p === 'SAND' ? PROC_CODES.slice(0, k + 1).reverse() : [];
    let pick = null, cause = p;
    const draw = () => {
      const item = list.find(x => x.t.ja === pick);
      openModal(head + '<h3>' + esc(p === 'BOND' ? t('symptom') : t('defect')) + '（' + (r.remain - Number(st.good)) + '）</h3>' +
        '<div class="choices">' + list.map(x => '<button data-r="' + esc(x.t.ja) + '" class="' + (pick === x.t.ja ? 'on' : '') + '">' + esc(optT(x)) + '</button>').join('') + '</div>' +
        (pick === 'その他' ? '<label>' + esc(t('otherText')) + '</label><input id="c-other" type="text" maxlength="30">' : '') +
        (causes.length ? '<label>' + esc(t('cause')) + '</label><div class="choices">' + causes.map(c => '<button data-c="' + c + '" class="' + (cause === c ? 'on' : '') + '" style="border-color:var(--' + c + ')">' + esc(procName(c)) + '</button>').join('') + '</div>' : '') +
        (p === 'BOND' && item ? '<div class="sub">' + esc(t('causeGuess')) + '：' + esc(item.cause && item.cause !== '不明' ? procName(normProc(item.cause)) : t('unknown')) + '</div>' : '') +
        '<div class="err" id="c-err"></div><div class="row"><button id="c-back">' + esc(t('back')) + '</button><button id="c-ok" class="primary"' + (pick ? '' : ' disabled') + '>' + esc(t('record')) + '</button></div>');
      document.querySelectorAll('#modal-body button[data-r]').forEach(b => b.addEventListener('click', () => { pick = b.dataset.r; const o = $('c-other'); const keep = o ? o.value : ''; draw(); if ($('c-other')) { $('c-other').value = keep; $('c-other').focus(); } }));
      document.querySelectorAll('#modal-body button[data-c]').forEach(b => b.addEventListener('click', () => { cause = b.dataset.c; const o = $('c-other'); const keep = o ? o.value : ''; draw(); if ($('c-other')) $('c-other').value = keep; }));
      $('c-back').addEventListener('click', stepRest);
      $('c-ok').addEventListener('click', () => {
        const other = $('c-other') ? $('c-other').value.trim() : '';
        if (pick === 'その他' && !other) { $('c-err').textContent = t('otherText'); sound('warn'); return; }
        send({ rest: 'scrap', defect: pick, other: other, cause: causes.length ? cause : '' });
      });
    };
    draw();
  };
  const send = extra => {
    closeModal();
    const data = Object.assign({ proc: p, id: r.id, good: st.good, boards: p === 'MOLD' ? st.boards : '' }, extra);
    queueOp('complete', data, r.pno + ' ' + t('complete'), who);
  };
  stepQty();
}

// ---------- 中断 ----------
function openInterrupt(r, who) {
  let pick = null;
  const draw = () => {
    openModal('<h3>' + esc(t('interrupt')) + '　' + esc(r.pno) + '</h3><div class="sub">' + esc(t('stopReason')) + '</div>' +
      '<div class="choices">' + (S.settings.stops || []).map(x => '<button data-r="' + esc(x.t.ja) + '" class="' + (pick === x.t.ja ? 'on' : '') + '">' + esc(optT(x)) + '</button>').join('') + '</div>' +
      (pick === 'その他' ? '<label>' + esc(t('otherText')) + '</label><input id="i-other" type="text" maxlength="30">' : '') +
      '<label>' + esc(t('doneSoFar')) + '</label><div class="numbox"><input id="i-good" type="text" inputmode="numeric" autocomplete="off"></div>' + numPad() +
      '<div class="err" id="i-err"></div><div class="row"><button id="i-cancel">' + esc(t('cancel')) + '</button><button id="i-ok" class="primary"' + (pick ? '' : ' disabled') + '>' + esc(t('record')) + '</button></div>');
    wireNumPad([$('i-good')]);
    document.querySelectorAll('#modal-body button[data-r]').forEach(b => b.addEventListener('click', () => {
      const g = $('i-good').value; pick = b.dataset.r; draw(); $('i-good').value = g; if ($('i-other')) $('i-other').focus();
    }));
    $('i-cancel').addEventListener('click', closeModal);
    $('i-ok').addEventListener('click', () => {
      const other = $('i-other') ? $('i-other').value.trim() : '';
      const good = $('i-good').value.trim();
      if (pick === 'その他' && !other) { $('i-err').textContent = t('otherText'); sound('warn'); return; }
      if (good && Number(good) > r.remain) { $('i-err').textContent = t('remain') + ' ' + r.remain; sound('warn'); return; }
      closeModal();
      queueOp('interrupt', { proc: S.proc, id: r.id, reason: pick, other: other, good: good }, r.pno + ' ' + t('interrupt'), who);
    });
  };
  draw();
}

// ---------- 変更 ----------
function openChange(r, who, preset) {
  const keys = S.proc === 'MOLD' ? ['size', 'matId', 'moldEq'] : ['cutEq', 'jig'];
  const items = (S.settings.changeItems || []).filter(x => keys.indexOf(x.key) >= 0);
  let pick = preset && items.some(x => x.key === preset) ? preset : (items[0] ? items[0].key : '');
  const draw = () => {
    const it = items.find(x => x.key === pick);
    openModal('<h3>' + esc(t('change')) + '　' + esc(r.pno) + '</h3><div class="sub">' + esc(t('changeNote')) + '</div>' +
      '<div class="sub">' + esc(t('changeWhat')) + '</div><div class="choices">' + items.map(x => '<button data-k="' + x.key + '" class="' + (pick === x.key ? 'on' : '') + '">' + esc(t(x.key)) + '<br><span class="note">' + esc(r[x.key] || '—') + '</span></button>').join('') + '</div>' +
      '<label>' + esc(t('newValue')) + '</label>' +
      (it && it.choices ? '<div class="choices">' + it.choices.map(c => '<button data-v="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>' :
        '<input id="g-val" type="text" maxlength="60" value="' + esc(r[pick] || '') + '">') +
      '<div class="err" id="g-err"></div><div class="row"><button id="g-cancel">' + esc(t('cancel')) + '</button>' + (it && it.choices ? '' : '<button id="g-ok" class="primary">' + esc(t('record')) + '</button>') + '</div>');
    document.querySelectorAll('#modal-body button[data-k]').forEach(b => b.addEventListener('click', () => { pick = b.dataset.k; draw(); }));
    const go = v => {
      v = String(v || '').trim();
      if (!v) { $('g-err').textContent = t('newValue'); sound('warn'); return; }
      if (v === (r[pick] || '')) { closeModal(); return; }
      closeModal();
      queueOp('change', { proc: S.proc, id: r.id, item: pick, value: v }, r.pno + ' ' + t(pick), who);
    };
    document.querySelectorAll('#modal-body button[data-v]').forEach(b => b.addEventListener('click', () => go(b.dataset.v)));
    if ($('g-ok')) {
      $('g-ok').addEventListener('click', () => go($('g-val').value));
      $('g-val').addEventListener('keydown', e => { if (e.key === 'Enter') go($('g-val').value); if (e.key === 'Escape') closeModal(); });
      $('g-val').focus();
    }
    $('g-cancel').addEventListener('click', closeModal);
  };
  draw();
}

// ---------- 取り消し ----------
async function doUndo(r, who) {
  let undo = r.undo;
  if (who.monitor) {
    // 大型モニターの一覧はログインなしで読んでいるので、取り消す人で読み直して確かめる
    loading(true);
    try {
      const j = await api('list', { proc: S.proc }, who.token);
      const x = j.rows.find(y => String(y.id) === String(r.id));
      undo = x && x.undo;
    } catch (e) {
      undo = null;
    } finally {
      loading(false);
    }
  }
  if (!undo || !undo.ok) {
    sound('ng');
    toast(t('undoLimit') + (undo && undo.why ? '：' + undo.why : ''), true);
    return;
  }
  queueOp('undo', { proc: S.proc, id: r.id, opId: undo.opId }, r.pno + ' ' + t('undo'), who);
}

// ---------- モーダル ----------
function openModal(html) { $('modal-body').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); $('modal-body').innerHTML = ''; S.relogin = null; }
function modalOpen() { return !$('modal').classList.contains('hidden'); }

// ---------- 全体の進み具合（ログインなしで見るだけ） ----------
async function loadBoard() {
  try {
    S.board = await getBoard();
    if (S.view === 'board') renderBoard();
  } catch (e) {
    if (S.view === 'board') toast(e.message, true);
  }
}

const SORT_KEYS = ['MOLD', 'CUT', 'SAND', 'BOND', 'SHIP'];
function boardSort() { const v = lsGet('zw_bsort'); return v && SORT_KEYS.indexOf(v.key) >= 0 ? v : { key: 'MOLD', dir: 'asc' }; }
function sortKeyName(k) { return k === 'SHIP' ? t('shipPlan') : procName(k) + ' ' + t('startPlan'); }
/** 注文の並べ替えに使う日付（その注文の行のうちいちばん早い日。無ければ ''） */
function orderDate(o, key) {
  const k = PROC_CODES.indexOf(key);
  const ds = o.rows.map(r => key === 'SHIP' ? r.ship : (r.procs[k] && r.procs[k].start) || '').filter(Boolean).sort();
  return ds[0] || '';
}
function md(d) { return d ? d.slice(5).replace('-', '/') : ''; }
/** 検索の比べ方: 全角半角・大文字小文字・空白と「-」の違いを無視 */
function nz(s) { return String(s == null ? '' : s).normalize('NFKC').toUpperCase().replace(/[\s\-‐－ー_]/g, ''); }

/** マスを押して作業一覧へ移れるか。対象外・ボードだけの画面・URLで工程を固定した端末の他の工程・担当外は押せない */
function canJump(c, x) {
  if (BOARD_ONLY || x.st === '対象外') return false;
  if (FIX_PROC && c !== FIX_PROC) return false;
  if (S.token && S.user) return S.user.procs.indexOf(c) >= 0;
  return true;   // ログインしていなければ押したときにログインを聞く（大型モニターはそのまま一覧）
}

function jumpTo(c, id) {
  touchAct();
  S.jump = { proc: c, id: String(id) };
  if (S.token || MONITOR) {
    S.proc = c; S.rows = []; S.listAt = '';
    if (c !== 'CUT') S.machine = FIX_MACHINE;
    saveSession(); show('list'); loadList();
    return;
  }
  S.proc = c;
  show('login');
}

function boardRows(b) {
  const q = nz(S.bq);
  const so = boardSort();
  const list = [];
  b.orders.forEach(o => {
    const om = q && nz(o.order).indexOf(q) >= 0;
    const rows = o.rows.filter(r => {
      if (q && !om && nz(r.pno).indexOf(q) < 0) return false;
      if (S.bf === 'short') return !!r.short;
      if (S.bf === 'today') return r.procs.some(x => x.doneDay && x.doneDay === b.today);
      return true;
    });
    if (rows.length) list.push({ o: o, rows: rows, d: orderDate(o, so.key) });
  });
  list.sort((x, y) => {
    if (!x.d !== !y.d) return x.d ? -1 : 1;           // 日付の無い注文はいつも最後
    const c = x.d < y.d ? -1 : x.d > y.d ? 1 : 0;
    return (so.dir === 'asc' ? c : -c) || String(x.o.order).localeCompare(String(y.o.order));
  });
  return list;
}

/** 工程の1マス（押せるならボタン） */
function bcell(r, x, k) {
  const c = PROC_CODES[k];
  const style = x.st === '済' ? 'background:var(--' + c + ');border-color:var(--' + c + ')' : x.st === '作業中' ? 'border-color:var(--' + c + ');color:var(--' + c + ')' : '';
  const n = x.st === '対象外' ? '' : (x.good || x.st !== '未' ? ' ' + x.good + '/' + r.qty : '');
  const plan = x.st === '対象外' || !x.start ? '' : '<div class="plan">' + esc(md(x.start)) + (x.end && x.end !== x.start ? '〜' + esc(md(x.end)) : '') + '</div>';
  const label = esc(t('st_' + x.st)) + esc(n);
  const el = canJump(c, x) ? '<button class="cell go ' + esc(x.st) + '" style="' + style + '" data-jp="' + c + '" data-jid="' + esc(r.id) + '" title="' + esc(procName(c)) + '">' + label + '</button>' :
    '<span class="cell ' + esc(x.st) + '" style="' + style + '">' + label + '</span>';
  return el + plan;
}

function renderBoard() {
  const b = S.board;
  const so = boardSort();
  const ae = document.activeElement, keep = ae && ae.id === 'bs-q' ? [ae.selectionStart, ae.selectionEnd] : null;
  let h = '<div class="board-head"><h2 class="sec" style="flex:1 1 200px">' + esc(t('board')) + '</h2>' +
    '<label class="note" for="bs-key">' + esc(t('sortBy')) + '</label><select id="bs-key">' +
    SORT_KEYS.map(k => '<option value="' + k + '"' + (k === so.key ? ' selected' : '') + '>' + esc(sortKeyName(k)) + '</option>').join('') + '</select>' +
    '<button id="bs-dir" class="sm accent">' + esc(so.dir === 'asc' ? t('asc') : t('desc')) + '</button>' +
    '<span class="note">' + esc(t('updated')) + ' ' + esc(b ? b.at : '…') + '</span></div>' +
    '<div class="board-find"><input id="bs-q" type="search" autocomplete="off" placeholder="' + esc(t('searchPh')) + '" value="' + esc(S.bq) + '">' +
    '<div class="chips">' + [['all', 'fAll'], ['short', 'fShort'], ['today', 'fDoneToday']].map(f => '<button class="sm' + (S.bf === f[0] ? ' on' : '') + '" data-bf="' + f[0] + '">' + esc(t(f[1])) + '</button>').join('') + '</div></div>';
  if (!b) { $('view').innerHTML = h; wireBoardHead(keep); return; }
  const list = boardRows(b);
  const total = b.orders.length;
  h += '<div class="note">' + esc(t('shown')) + ' ' + list.length + ' ／ ' + total + (BOARD_ONLY ? '' : '　' + esc(t('tapCell'))) + '</div>';
  if (NARROW.matches) {
    // スマホ幅: 注文ごとのまとまりに、工程4つを2列×2段で
    h += '<div class="bcards">' + list.map(({ o, rows, d }) => '<div class="bcard"><div class="bhead"><span>' + esc(md(d)) + '</span><b>' + esc(t('order')) + ' ' + esc(o.order) + '</b></div>' +
      rows.map(r => '<div class="brow' + (r.done ? ' done' : '') + '"><div><b>' + esc(r.pno) + '</b>' + (r.kind === 'SC' ? ' <span class="note">SC</span>' : '') +
        ' <span class="note">' + esc(t('planned')) + ' ' + r.qty + '</span>' + (r.short ? ' <span class="shortmark">' + esc(r.short) + '</span>' : '') +
        '<div class="name note">' + esc(r.part) + '</div></div><div class="bprocs">' +
        r.procs.map((x, k) => '<div class="bp"><div class="pn" style="color:var(--' + PROC_CODES[k] + ')">' + esc(procName(PROC_CODES[k])) + '</div>' + bcell(r, x, k) + '</div>').join('') +
        '</div></div>').join('') + '</div>').join('') + '</div>';
  } else {
    h += '<table class="board"><thead><tr><th>' + esc(sortKeyName(so.key)) + '</th><th>' + esc(t('order')) + '</th><th></th><th>' + esc(t('planned')) + '</th>' +
      PROC_CODES.map(c => '<th style="color:var(--' + c + ')">' + esc(procName(c)) + '</th>').join('') + '</tr></thead><tbody>';
    list.forEach(({ o, rows, d }) => {
      rows.forEach((r, i) => {
        h += '<tr class="' + (r.done ? 'done' : '') + '">' +
          (i === 0 ? '<td rowspan="' + rows.length + '">' + esc(md(d)) + '</td><td class="order" rowspan="' + rows.length + '">' + esc(o.order) + '</td>' : '') +
          '<td><b>' + esc(r.pno) + '</b>' + (r.kind === 'SC' ? ' <span class="note">SC</span>' : '') + '<div class="name note">' + esc(r.part) + '</div>' +
          (r.short ? '<div class="shortmark">' + esc(r.short) + '</div>' : '') + '</td><td>' + r.qty + '</td>' +
          r.procs.map((x, k) => '<td>' + bcell(r, x, k) + '</td>').join('') + '</tr>';
      });
    });
    h += '</tbody></table>';
  }
  if (!list.length) h += '<div class="empty">' + esc(t('none')) + '</div>';
  $('view').innerHTML = h;
  wireBoardHead(keep);
  document.querySelectorAll('#view button[data-jp]').forEach(el => el.addEventListener('click', () => jumpTo(el.dataset.jp, el.dataset.jid)));
}

function wireBoardHead(keep) {
  $('bs-key').addEventListener('change', e => { const so = boardSort(); so.key = e.target.value; lsSet('zw_bsort', so); renderBoard(); });
  $('bs-dir').addEventListener('click', () => { const so = boardSort(); so.dir = so.dir === 'asc' ? 'desc' : 'asc'; lsSet('zw_bsort', so); renderBoard(); });
  const q = $('bs-q');
  q.addEventListener('input', () => { S.bq = q.value; renderBoard(); });
  q.addEventListener('keydown', e => { if (e.key === 'Escape') { S.bq = ''; renderBoard(); } });
  if (keep) { q.focus(); try { q.setSelectionRange(keep[0], keep[1]); } catch (e) {} }
  document.querySelectorAll('.board-find button[data-bf]').forEach(el => el.addEventListener('click', () => { S.bf = el.dataset.bf; renderBoard(); }));
}
NARROW.addEventListener('change', () => { if (S.view === 'board') renderBoard(); });

// ---------- 上のバーのボタン ----------
$('btn-board').addEventListener('click', () => {
  touchAct();
  if (S.view === 'board') { if (S.proc) { show('list'); loadList(); } else show(S.token ? 'procs' : 'login'); }
  else show('board');
});
$('btn-refresh').addEventListener('click', () => { touchAct(); if (S.view === 'board') loadBoard(); else loadList(); });
$('btn-logout').addEventListener('click', () => logout());
$('btn-lang').addEventListener('click', () => {
  openModal('<h3>' + esc(t('lang')) + '</h3>' + langButtons() + '<div class="row"><button id="lg-cancel">' + esc(t('cancel')) + '</button></div>');
  $('lg-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('#modal-body .langs button').forEach(b => b.addEventListener('click', async () => {
    const lang = b.dataset.lang;
    closeModal();
    S.lang = lang;
    lsSet('zw_lang', lang);
    show(S.view);
    if (S.view === 'list') renderList();
    if (S.token) {
      try { await api('setLang', { lang: lang }); S.user.lang = lang; saveSession(); } catch (e) { toast(e.message, true); }
    }
  }));
});

function touchAct() { S.lastAct = Date.now(); if (S.token) saveSession(); }
document.addEventListener('pointerdown', () => { S.lastAct = Date.now(); });
setInterval(() => {
  if (!S.token || S.queue.some(q => q.token === S.token)) return;
  if (MONITOR ? Date.now() > S.monitorUntil : Date.now() - S.lastAct > IDLE_MS) logout();
}, 15000);
window.addEventListener('online', () => pump());

// ---------- 起動 ----------
(async function boot() {
  S.lang = lsGet('zw_lang') || 'ja';
  S.settings = lsGet('zw_settings');
  S.queue = (lsGet('zw_queue') || []);
  if (BOARD_ONLY) { show('board'); return; }
  if (!S.settings) {
    try { const j = await api('settings', {}, ''); S.settings = pickSettings(j); lsSet('zw_settings', S.settings); } catch (e) { /* ログインのときに取り直す */ }
  }
  const sess = MONITOR ? null : lsGet('zw_session');
  if (sess && sess.token && Date.now() - sess.at < IDLE_MS) {
    S.token = sess.token; S.user = sess.user; S.proc = FIX_PROC || sess.proc || '';
    if (S.user.lang) S.lang = S.user.lang;
    if (S.proc && S.user.procs.indexOf(S.proc) < 0) S.proc = '';
    if (S.proc) { show('list'); loadList(); } else show('procs');
  } else if (MONITOR) {
    S.proc = FIX_PROC;
    if (S.proc) { show('list'); loadList(); } else show('procs');
  } else {
    S.proc = FIX_PROC;
    show('login');
  }
  if (S.queue.length) pump();
})();
