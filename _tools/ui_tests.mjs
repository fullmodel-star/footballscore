/**
 * 800 世界盃推估器 · 瀏覽器層功能走查（安全網）
 *
 *   node _tools/ui_tests.mjs                     → 對專案根目錄跑
 *   node _tools/ui_tests.mjs --dir=<資料夾>      → 對別的副本跑（反向測試用；可給絕對路徑）
 *
 * 2026-10-03 建立：照 605 500碗 _tools/ui_tests.mjs 的寫法。這支只測、不改 App。
 *
 * 寫法與踩過的坑：
 * - 不用 --virtual-time-budget：一律真實時間輪詢（until）。
 * - 自己起 http server（Cache-Control: no-store），直接試綁埠、不先探測（Windows SO_REUSEADDR 會綁到別人的埠）。
 * - addScriptToEvaluateOnNewDocument 會累積：每次 open 先移除上一支再加，整段包 IIFE；alert/confirm 一律攔截記錄。
 * - 對外資料（ESPN 比分／新聞／名單、openfootball、TheSportsDB、Open-Meteo、Google 字型）全部用 CDP Fetch domain
 *   攔下來，回 _tools/fixtures/ 的固定假資料（或在「失敗模式」直接讓請求失敗）。
 *   另外 Chrome 加 --host-resolver-rules 把所有外部網域解析成 NOTFOUND：就算哪支請求沒被攔到，也只會失敗、
 *   不會真的連到 ESPN 拿到每天不同的資料（測試結果才會每次一致）。11.2 會檢查「每支外部請求都有被攔到」。
 * - 瀏覽器時區故意設成 America/Los_Angeles：App 必須自己換算台北時間，不能依賴裝置時區剛好是台灣。
 * - 首訪重整用「主框架導覽次數」判斷（605 學到的：在頁面放記號會趕不上重整）。
 * - 每條斷言印出樣本數／實際值，避免空集合假通過。
 */
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const ROOT = path.resolve(HERE, '..', dirArg ? dirArg.slice(6) : '.');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css',
  '.txt': 'text/plain', '.woff2': 'font/woff2' };
if (!existsSync(path.join(ROOT, 'index.html'))) { console.log('FAIL 受測資料夾沒有 index.html：' + ROOT); process.exit(2); }
const FIX = (f) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const SCOREBOARD = FIX('espn_scoreboard_group.json');
const NEWS = FIX('espn_news.json');
const OPENFOOTBALL = FIX('openfootball.json');
const METEO = FIX('open_meteo.json');

let pass = 0, fail = 0;
const failed = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

/* ── 假資料路由：依網址回固定內容；null＝不認得（會被當失敗，並記成「意外的對外連線」） ── */
function route(url) {
  const u = new URL(url);
  const json = (o) => ({ type: 'application/json', body: JSON.stringify(o) });
  if (u.hostname === 'fonts.googleapis.com') return { type: 'text/css', body: '/* fonts stubbed by ui_tests */' };
  if (u.hostname === 'site.api.espn.com') {
    if (u.pathname.endsWith('/scoreboard')) return json(u.searchParams.get('dates') === '20260611-20260627' ? SCOREBOARD : { events: [] });
    if (u.pathname.endsWith('/news')) {
      const now = Date.now();
      return json({ articles: NEWS.articles.map(({ _ageHours, ...a }) => ({ ...a, published: new Date(now - _ageHours * 3600e3).toISOString() })) });
    }
    if (u.pathname.endsWith('/summary')) return json({ rosters: [] });
  }
  if (u.hostname === 'raw.githubusercontent.com' && u.pathname.includes('/openfootball/')) return json(OPENFOOTBALL);
  if (u.hostname === 'www.thesportsdb.com') return json({ events: [] });
  if (u.hostname === 'api.open-meteo.com') return json(METEO);
  return null;
}

/* ── 靜態伺服器：直接試綁，失敗換下一個 ── */
async function startServer() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const p = path.join(ROOT, rel);
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const b = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(b);
    } catch { res.writeHead(404); res.end(); }
  });
  for (let port = 8800; port < 8840; port++) {
    const okBind = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (okBind) return { server, port };
  }
  throw new Error('找不到可用的埠');
}

/* ── 最小 CDP 用戶端 ── */
class CDP {
  constructor(ws) {
    Object.assign(this, { ws, id: 0, waiters: new Map(), errors: [], requests: [], initScript: null, navs: 0,
      netMode: 'fixture', paused: [], unknown: [] });
  }
  static async connect(debugPort) {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* Chrome 還沒起來 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('接不上 Chrome 的 CDP');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        c.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
      }
      if (m.method === 'Network.requestWillBeSent') c.requests.push(m.params.request.url);
      // 主框架每完成一次導覽（含 location.reload）就 +1；用來抓「頁面自己重整」
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && /^http/.test(m.params.frame.url)) c.navs++;
      if (m.method === 'Fetch.requestPaused') c.onPaused(m.params);
    };
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Network.enable');
    await c.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
    // 裝置時區故意不是台灣：App 必須自己換算台北時間
    await c.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
    return c;
  }
  onPaused(p) {
    const url = p.request.url;
    this.paused.push({ url, mode: this.netMode });
    const fx = this.netMode === 'fixture' ? route(url) : null;
    if (!fx) {
      if (this.netMode === 'fixture') this.unknown.push(url);
      this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' });
      return;
    }
    this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: fx.type + '; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(fx.body, 'utf8').toString('base64') });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.waiters.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
  async until(expr, ms = 8000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await this.eval(expr)) return true; } catch { /* 還沒 ready */ }
      await sleep(step);
    }
    return false;
  }
  async width(w, h = 844) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await sleep(200);
  }
  /** 開頁面：預設清本地資料；攔 alert/confirm（在頁面任何程式碼之前）。回傳是否載入完成。 */
  async open(url, { clear = true, net = 'fixture' } = {}) {
    // ⚠ addScriptToEvaluateOnNewDocument 會累積：每次 open 先移除上一支，再整段包成 IIFE。
    if (this.initScript) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.initScript });
    const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      ${clear ? 'try { localStorage.clear(); } catch(e) {}' : ''}
      window.__alerts = [];
      window.alert = (m) => { window.__alerts.push(String(m)); };
      window.confirm = (m) => { window.__alerts.push('confirm:' + String(m)); return true; };
    })();` });
    this.initScript = r.result && r.result.identifier;
    this.netMode = net;
    this.navs = 0;
    await this.send('Page.navigate', { url });
    return this.until(`document.querySelectorAll('#tabs button').length === 6 && !!document.querySelector('#main .card')`, 15000);
  }
}
async function untilNode(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

/* ── 獨立算式（不呼叫 App 的函式）── */
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const p2 = (n) => String(n).padStart(2, '0');
// 6～7 月：台北 UTC+8（無日光節約）、美東 EDT UTC−4、歐洲（巴黎）CEST UTC+2
function zoneExpect(iso, offH, withWd) {
  const d = new Date(Date.parse(iso) + offH * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}${withWd ? `（${WD[d.getUTCDay()]}）` : ''} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
// 由假資料比分算積分表：勝 3、平 1；排序 積分→淨勝→進球→（兩隊同分）對戰勝者
function standings(events, teamNames) {
  const rows = Object.fromEntries(teamNames.map((n) => [n, { n, pl: 0, pts: 0, gf: 0, ga: 0 }]));
  const games = [];
  for (const ev of events) {
    if (!ev.status.type.completed) continue;
    const [h, a] = ev.competitions[0].competitors;
    if (!rows[h.team.displayName] || !rows[a.team.displayName]) continue;
    const H = rows[h.team.displayName], A = rows[a.team.displayName], hs = +h.score, as = +a.score;
    games.push([H.n, A.n, hs, as]);
    H.pl++; A.pl++; H.gf += hs; H.ga += as; A.gf += as; A.ga += hs;
    if (hs > as) H.pts += 3; else if (hs < as) A.pts += 3; else { H.pts++; A.pts++; }
  }
  const list = Object.values(rows);
  list.forEach((r) => { r.gd = r.gf - r.ga; });
  list.sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || h2h(x.n, y.n));
  function h2h(x, y) {
    const g = games.find((k) => (k[0] === x && k[1] === y) || (k[0] === y && k[1] === x));
    if (!g) return 0;
    const [hx, ax] = g[0] === x ? [g[2], g[3]] : [g[3], g[2]];
    return ax - hx; // x 贏 → 負值 → x 排前
  }
  return list;
}

const { server, port } = await startServer();
const BASE = `http://127.0.0.1:${port}/`;
const profile = await mkdtemp(path.join(tmpdir(), 'wc800-ui-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
let c;
async function cleanup() {
  const exited = new Promise((r) => { if (chrome.exitCode !== null) r(); else chrome.once('exit', r); });
  try { chrome.kill(); } catch {}
  server.close();
  await Promise.race([exited, sleep(3000)]);
  // Chrome 子行程可能還鎖著設定檔資料夾：重試幾次，避免在暫存資料夾留下 wc800-ui-*
  try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
}

try {
  console.log('受測資料夾：' + ROOT);
  c = await CDP.connect(DEBUG_PORT);
  await c.width(390);
  const n = (sel) => c.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const tab = async (key) => {
    await c.eval(`[...document.querySelectorAll('#tabs button')].find(b=>(b.getAttribute('onclick')||'').includes("'${key}'")).click()`);
    return c.until(`[...document.querySelectorAll('#tabs button')].find(b=>(b.getAttribute('onclick')||'').includes("'${key}'")).classList.contains('on')`, 3000);
  };
  const mainText = () => c.eval(`document.getElementById('main').innerText`);
  const badWords = (t) => (t.match(/NaN|undefined|Infinity|\[object Object\]/g) || []);
  const alerts = () => c.eval(`window.__alerts.slice()`);

  /* ───────────────────────── 1 首訪載入 ───────────────────────── */
  console.log('\n[1 首訪載入（假資料模式）]');
  const loaded = await c.open(BASE);
  ok('1.1 頁面載入：底部 6 個分頁、主畫面有內容', loaded, await n('#tabs button'));
  ok('1.2 預設停在「四強」分頁', await c.eval(`document.querySelector('#tabs button.on').getAttribute('onclick').includes("'ko'")`));
  const kmN = await n('.kmatch');
  ok('1.3 對陣圖 32強→決賽共 31 場（16+8+4+2+1，實測 ' + kmN + '）', kmN === 31, kmN);
  const champ = await c.eval(`(()=>{const e=document.querySelector('.kchamp .kcn'); return e? e.textContent.trim() : ''})()`);
  const teamLabels = await c.eval(`TEAMS.map(t=>t[5]+' '+t[1])`);
  ok('1.4 推估冠軍橫幅是 48 隊之一（' + champ + '；名單 ' + teamLabels.length + ' 隊）', teamLabels.length === 48 && teamLabels.includes(champ), champ);
  const semiN = await n('.semitie');
  ok('1.5 四強焦點 2 組對戰都有畫出來（實測 ' + semiN + '）', semiN === 2, semiN);
  const nearN = await n('.near .nr');
  ok('1.6 近期賽事清單有列出比賽（實測 ' + nearN + ' 場）', nearN >= 3, nearN);
  const controlled = await c.until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, 10000);
  await sleep(2500);
  ok('1.7 🔴 第一次造訪 Service Worker 接管後，頁面不會自己重整（導覽次數＝1，實測 ' + c.navs + '）',
    controlled && c.navs === 1, { controlled, navs: c.navs });

  /* ───────────────────────── 2 開啟即自動抓資料（假資料） ───────────────────────── */
  console.log('\n[2 開啟自動更新比分／新聞（假資料）]');
  const fetched = await c.until(`S.lastScoreTs > 0 && S.lastNewsTs > 0`, 10000);
  ok('2.1 開啟後自動抓了 ESPN 比分與新聞（lastScoreTs／lastNewsTs 都有寫）', fetched,
    c.paused.map((p) => p.url.replace(/^https:\/\/[^/]+/, '')).slice(0, 6));
  const res = await c.eval(`JSON.parse(JSON.stringify(S.results))`);
  ok('2.2 假比分已寫入：加拿大 0-2 波士尼亞覆寫內建 1-1、瑞士 0-1 加拿大（' + JSON.stringify([res[2], res[48]]) + '）',
    JSON.stringify(res[2]) === '[0,2]' && JSON.stringify(res[48]) === '[0,1]', { r2: res[2], r48: res[48] });
  ok('2.3 未完賽（美國 5-0 澳洲）與隊名對不上的場次被忽略（第 28 場 = ' + JSON.stringify(res[28] ?? null) + '）',
    res[28] === undefined, res[28]);
  const resKeys = Object.keys(res).length;
  ok('2.4 已有賽果場數＝內建 4 場＋假資料新增 9 場＝13（實測 ' + resKeys + '）', resKeys === 13, Object.keys(res));
  await c.until(`(document.getElementById('toast')||{}).textContent && document.getElementById('toast').textContent.includes('已自動更新')`, 4000);
  const toastT = await c.eval(`(document.getElementById('toast')||{}).textContent||''`);
  ok('2.5 有提示「已自動更新 10 場比分」（實測「' + toastT + '」）', toastT.includes('已自動更新 10 場比分'), toastT);
  const pend = await c.eval(`S.pending.map(p=>p.id)`);
  ok('2.6 待審新聞只收 3 則相關的（無關／太舊／非 ESPN 連結都排除；實測 ' + JSON.stringify(pend) + '）',
    JSON.stringify(pend) === '["9001","9002","9003"]', pend);
  const badge = await c.eval(`(document.querySelector('#tabs .bdg')||{}).textContent||''`);
  ok('2.7 新聞分頁出現待審數字徽章 3（實測「' + badge + '」）', badge === '3', badge);

  /* ───────────────────────── 3 台北時區換算 ───────────────────────── */
  console.log('\n[3 賽程與台北時區（瀏覽器時區故意設成洛杉磯）]');
  await tab('sched');
  const mN = await n('#main .match');
  ok('3.1 歷史分頁列出 72 場小組賽（實測 ' + mN + '）', mN === 72, mN);
  const kick = await c.eval(`KICK.slice()`);
  const tzRows = await c.eval(`[...document.querySelectorAll('#main .match')].map(m=>[...m.querySelectorAll('.tz b')].map(b=>b.textContent))`);
  const tzBad = [];
  tzRows.forEach((r, i) => {
    const want = [zoneExpect(kick[i], 8, true), zoneExpect(kick[i], -4, false), zoneExpect(kick[i], 2, false)];
    if (r.join('|') !== want.join('|')) tzBad.push({ i, got: r, want });
  });
  ok('3.2 72 場的台灣時間（含星期）都等於 UTC+8 獨立換算（樣本 ' + tzRows.length + '；例：第 0 場 ' + (tzRows[0] || [])[0] + '）',
    tzRows.length === 72 && kick.length === 72 && tzBad.length === 0, tzBad.slice(0, 3));
  ok('3.3 開幕戰 UTC 6/11 19:00 → 台灣「6/12（五） 03:00」、美東 6/11 15:00、歐洲 6/11 21:00（實測 ' + JSON.stringify(tzRows[0]) + '）',
    JSON.stringify(tzRows[0]) === JSON.stringify(['6/12（五） 03:00', '6/11 15:00', '6/11 21:00']), tzRows[0]);
  // 台灣日期 ≠ UTC 日期的場次數（UTC 16:00 以後開球的都會跨到台灣隔天）
  const crossDay = tzRows.filter((r, i) => r[0] && r[0].split('（')[0] !== `${+kick[i].slice(5, 7)}/${+kick[i].slice(8, 10)}`).length;
  ok('3.4 有跨日的場次（UTC 晚場→台灣隔天）確實存在，3.2 不是只驗到同日場（跨日 ' + crossDay + ' 場）', crossDay >= 10, crossDay);

  /* ───────────────────────── 4 小組積分 ───────────────────────── */
  console.log('\n[4 小組積分計算（用假資料的固定比分驗算）]');
  const readTable = () => c.eval(`[...document.querySelectorAll('#main table.sim tr')].slice(1).map(tr=>{const td=tr.querySelectorAll('td'); return [td[0].querySelector('.flagn').textContent.replace(/^\\S+\\s/,''), td[1].textContent, td[2].textContent, td[3].textContent]})`);
  const zh = { 'Mexico': '墨西哥', 'South Africa': '南非', 'South Korea': '南韓', 'Czechia': '捷克',
    'Canada': '加拿大', 'Bosnia and Herzegovina': '波士尼亞', 'Qatar': '卡達', 'Switzerland': '瑞士' };
  const sg = (x) => (x > 0 ? '+' : '') + x;
  for (const [g, names] of [['A', ['Mexico', 'South Africa', 'South Korea', 'Czechia']], ['B', ['Canada', 'Bosnia and Herzegovina', 'Qatar', 'Switzerland']]]) {
    await c.eval(`[...document.querySelectorAll('.gfilter button')].find(b=>b.textContent==='${g}組').click()`);
    await c.until(`!!document.querySelector('#main table.sim')`, 3000);
    const got = await readTable();
    const want = standings(SCOREBOARD.events, names).map((r) => [zh[r.n], String(r.pl), r.pts.toFixed(1), sg(r.gd)]);
    ok(`4.${g} ${g} 組積分榜（名次／已踢／積分／淨勝）＝獨立驗算（${got.length} 隊：${got.map((r) => r[0] + r[2]).join('、')}）`,
      got.length === 4 && JSON.stringify(got) === JSON.stringify(want), { got, want });
  }
  const bTop = (await readTable()).map((r) => r[0]);
  ok('4.C B 組加拿大、瑞士同積分同淨勝同進球，靠對戰勝出的加拿大排第一（實測 ' + bTop.slice(0, 2).join('>') + '；瑞士 Elo 較高，不能靠 Elo 排）',
    bTop[0] === '加拿大' && bTop[1] === '瑞士', bTop);

  // 手動輸入比分 → C 組積分即時更新；只填一格不存檔；清空恢復預測
  await c.eval(`[...document.querySelectorAll('.gfilter button')].find(b=>b.textContent==='C組').click()`);
  await c.until(`!!document.getElementById('gm5')`, 3000);
  await c.eval(`(()=>{const i=document.querySelectorAll('#gm5 .sc input'); i[0].value='3'; i[0].dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`!!document.querySelector('#gm5 .sc input')`, 2000);
  await c.eval(`(()=>{const i=document.querySelectorAll('#gm5 .sc input'); i[1].value='1'; i[1].dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`JSON.stringify(S.results[5])==='[3,1]'`, 2000);
  const cTab = await readTable();
  const bra = cTab.find((r) => r[0] === '巴西'), mar = cTab.find((r) => r[0] === '摩洛哥');
  ok('4.D 手動輸入巴西 3:1 摩洛哥 → C 組巴西已踢 1、淨勝 +2，摩洛哥 −2（' + JSON.stringify([bra, mar]) + '）',
    !!bra && !!mar && bra[1] === '1' && bra[3] === '+2' && mar[1] === '1' && mar[3] === '-2', cTab);
  ok('4.E 兩格都填好的比分有存進 localStorage', await c.eval(`JSON.stringify(JSON.parse(localStorage.getItem('wc2026_predictor_v2')).results[5])==='[3,1]'`));
  await c.eval(`(()=>{const i=document.querySelectorAll('#gm5 .sc input'); i[0].value=''; i[0].dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`S.results[5]===undefined`, 2000);
  const braBack = (await readTable()).find((r) => r[0] === '巴西');
  ok('4.F 清空任一格 → 整場恢復為預測（巴西已踢回到 0，實測 ' + JSON.stringify(braBack) + '）', !!braBack && braBack[1] === '0', braBack);
  await c.eval(`(()=>{const i=document.querySelectorAll('#gm6 .sc input'); i[0].value='2'; i[0].dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`Array.isArray(S.results[6])`, 2000);
  ok('4.G 只填一格（海地 2:–）不寫入 localStorage（避免 NaN 變成 0:0 幻影賽果）',
    await c.eval(`JSON.parse(localStorage.getItem('wc2026_predictor_v2')).results[6]===undefined`),
    await c.eval(`JSON.parse(localStorage.getItem('wc2026_predictor_v2')).results[6]`));
  await c.open(BASE, { clear: false });
  ok('4.H 重開頁面後半填的那場仍是預測、先前 13 場賽果保留（' + await c.eval(`Object.keys(S.results).length`) + ' 場）',
    await c.eval(`S.results[6]===undefined && Object.keys(S.results).length===13`));

  /* ───────────────────────── 5 對戰預測 ───────────────────────── */
  console.log('\n[5 對戰預測數值合理]');
  await tab('pred');
  const setPair = async (a, b, venue) => {
    await c.eval(`(()=>{const s=document.querySelectorAll('.vsbox select'); s[0].value='${a}'; s[0].dispatchEvent(new Event('change')); return 1})()`);
    await c.eval(`(()=>{const s=document.querySelectorAll('.vsbox select'); s[1].value='${b}'; s[1].dispatchEvent(new Event('change')); return 1})()`);
    await c.eval(`(()=>{const s=document.querySelector('.card .row select'); s.value='${venue}'; s.dispatchEvent(new Event('change')); return 1})()`);
    await c.until(`S.pA===${a} && S.pB===${b} && S.pV==='${venue}' && !!document.querySelector('.probbar')`, 3000);
  };
  const readPred = () => c.eval(`(()=>{
    const pb=[...document.querySelectorAll('.probbar > div')].map(d=>parseFloat(d.textContent));
    const xg=[...document.querySelectorAll('.bigvs .xg')].map(d=>parseFloat(d.textContent));
    const bd=[...document.querySelectorAll('.breakdown .bd')].map(b=>({
      rows:[...b.querySelectorAll('.li:not(.tot)')].map(li=>[li.children[0].textContent, parseInt(li.children[1].textContent.replace('+',''),10)]),
      tot:parseInt(b.querySelector('.li.tot').children[1].textContent,10)}));
    const cells=[...document.querySelectorAll('table.score td')].map(td=>parseFloat(td.textContent));
    return {pb,xg,bd,cells,txt:document.getElementById('main').innerText};
  })()`);
  const pairs = [[28, 6, 'N', '西班牙 vs 卡達（中立）'], [36, 32, 'auto', '阿根廷 vs 法國'], [0, 1, 'auto', '墨西哥 vs 南非（主辦國）'], [28, 19, '0', '西班牙 vs 厄瓜多（墨西哥城高原）']];
  const preds = {};
  for (const [a, b, v, label] of pairs) {
    await setPair(a, b, v);
    const r = await readPred();
    preds[label] = r;
    const sum = r.pb.reduce((x, y) => x + y, 0);
    const bdOk = r.bd.length === 2 && r.bd.every((x) => x.rows.length >= 10 && x.rows.every((k) => Number.isFinite(k[1])) && x.rows.reduce((s, k) => s + k[1], 0) === x.tot);
    const cellSum = r.cells.reduce((x, y) => x + y, 0);
    ok(`5.${label}：勝平負 ${r.pb.join('/')}％ 加總≈100（${sum.toFixed(1)}）、期望進球 ${r.xg.join(':')} 為正數、${r.cells.length} 格比分機率合計 ${cellSum.toFixed(1)}％、兩隊實力拆解逐項加總＝有效 Elo、無 NaN`,
      r.pb.length === 3 && Math.abs(sum - 100) <= 0.15 && r.pb.every((x) => x >= 0) && r.xg.length === 2 && r.xg.every((x) => Number.isFinite(x) && x > 0)
      && r.cells.length === 36 && cellSum > 85 && cellSum <= 100.5 && bdOk && badWords(r.txt).length === 0,
      { pb: r.pb, xg: r.xg, cellSum, bd: r.bd.map((x) => [x.rows.reduce((s, k) => s + k[1], 0), x.tot]), bad: badWords(r.txt) });
  }
  const sq = preds['西班牙 vs 卡達（中立）'];
  ok('5.強弱 西班牙（Elo 2157）對卡達（1421）勝率 > 70%（實測 ' + sq.pb[0] + '%）', sq.pb[0] > 70, sq.pb);
  const alt = preds['西班牙 vs 厄瓜多（墨西哥城高原）'].bd.map((b) => (b.rows.find((k) => k[0].includes('高原')) || [])[1]);
  ok('5.高原 墨西哥城（2240m）：西班牙高原 −45（43×1.04）、厄瓜多免疫 0（實測 ' + JSON.stringify(alt) + '）', alt[0] === -45 && alt[1] === 0, alt);
  const home = preds['墨西哥 vs 南非（主辦國）'].bd.map((b) => (b.rows.find((k) => k[0].includes('主場優勢')) || [])[1]);
  ok('5.主場 自動場地：主辦國墨西哥 +50、南非 0（實測 ' + JSON.stringify(home) + '）', home[0] === 50 && home[1] === 0, home);
  await c.eval(`document.querySelector('.swap').click()`);
  await c.until(`S.pA===19 && S.pB===28`, 2000);
  const sw = await readPred();
  const before = preds['西班牙 vs 厄瓜多（墨西哥城高原）'].pb;
  ok('5.對調 ⇄ 對調主客後勝負機率互換（' + before.join('/') + ' → ' + sw.pb.join('/') + '）',
    Math.abs(sw.pb[0] - before[2]) <= 0.1 && Math.abs(sw.pb[2] - before[0]) <= 0.1 && Math.abs(sw.pb[1] - before[1]) <= 0.1, { before, after: sw.pb });

  /* ───────────────────────── 6 球隊 ───────────────────────── */
  console.log('\n[6 球隊：球員狀態影響實力]');
  await tab('teams');
  const trN = await n('.trow');
  ok('6.1 球隊分頁列出 48 隊（實測 ' + trN + '）', trN === 48, trN);
  const argElo = () => c.eval(`parseInt([...document.querySelectorAll('.trow')].find(r=>r.querySelector('.nm').textContent.startsWith('阿根廷')).querySelector('.elo').textContent,10)`);
  const e0 = await argElo();
  await c.eval(`[...document.querySelectorAll('.trow')].find(r=>r.querySelector('.nm').textContent.startsWith('阿根廷')).querySelector('.head').click()`);
  await c.until(`document.querySelectorAll('.prow').length > 0`, 2000);
  const p0 = await c.eval(`document.querySelector('.prow .pn').textContent`);
  await c.eval(`(()=>{const s=document.querySelector('.prow select'); s.value='3'; s.dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`document.querySelector('.prow').classList.contains('st3')`, 2000);
  const e1 = await argElo();
  ok('6.2 把 ' + p0 + '（5★）標缺陣 → 阿根廷有效 Elo 少 40（5★×8；' + e0 + '→' + e1 + '）', p0 === 'Lionel Messi' && e0 - e1 === 40, { p0, e0, e1 });
  await c.eval(`(()=>{const s=document.querySelector('.prow select'); s.value='0'; s.dispatchEvent(new Event('change')); return 1})()`);
  await c.until(`!document.querySelector('.prow').classList.contains('st3')`, 2000);
  ok('6.3 改回正常 → Elo 恢復（' + await argElo() + '）', (await argElo()) === e0);

  /* ───────────────────────── 7 新聞 ───────────────────────── */
  console.log('\n[7 新聞（假資料）]');
  await tab('news');
  const pitems = await c.eval(`[...document.querySelectorAll('.pitem')].map(p=>({h:p.querySelector('.ph').textContent, imgs:p.querySelectorAll('.ph img').length, href:(p.querySelector('.pd a')||{}).href||''}))`);
  ok('7.1 待審清單 3 則，每則都有連到 espn.com 的「閱讀原文」（' + pitems.length + ' 則）',
    pitems.length === 3 && pitems.every((p) => /^https:\/\/www\.espn\.com\//.test(p.href)), pitems);
  ok('7.2 標題裡的 HTML 被轉義成文字、沒被執行（<img> 元素 0 個、__xss 未設定）',
    pitems.length === 3 && pitems.every((p) => p.imgs === 0) && pitems.some((p) => p.h.includes('<img')) && await c.eval(`window.__xss === undefined`), pitems.map((p) => p.h));
  const nb = await c.eval(`[eloBreak(32).news, eloBreak(28).news]`);
  const nA = (await alerts()).length;
  await c.eval(`[...document.querySelectorAll('#main .btn')].find(b=>b.textContent.includes('一鍵納入')).click()`);
  await c.until(`window.__alerts.length > ${nA}`, 3000);
  const accMsg = (await alerts()).slice(nA).join(' / ');
  const na = await c.eval(`[eloBreak(32).news, eloBreak(28).news]`);
  ok('7.3 一鍵納入：只收 2 則有影響值的，法國新聞因素 −15、西班牙 +6（' + JSON.stringify(nb) + '→' + JSON.stringify(na) + '；' + accMsg.slice(0, 40) + '）',
    accMsg.includes('已一鍵納入 2 則') && na[0] - nb[0] === -15 && na[1] - nb[1] === 6, { nb, na, accMsg });
  ok('7.4 剩 1 則（影響 0）留待人工確認', (await n('.pitem')) === 1, await n('.pitem'));

  /* ───────────────────────── 8 淘汰賽對陣 ───────────────────────── */
  console.log('\n[8 淘汰賽：點隊伍改派晉級]');
  await tab('ko');
  const fin = await c.eval(`(()=>{const k=[...document.querySelectorAll('.kmatch')].pop(); const lose=k.querySelector('.krow.lose.pick'); return lose? lose.querySelector('.kteam').textContent.trim() : null})()`);
  await c.eval(`[...document.querySelectorAll('.kmatch')].pop().querySelector('.krow.lose.pick').click()`);
  await c.until(`document.querySelector('.kchamp .kcn').textContent.trim() === ${JSON.stringify(fin)}`, 3000);
  const champ2 = await c.eval(`document.querySelector('.kchamp .kcn').textContent.trim()`);
  ok('8.1 決賽點另一隊 → 推估冠軍變成 ' + fin + '（實測 ' + champ2 + '），出現「清除手動指定（1）」',
    !!fin && champ2 === fin && await c.eval(`document.getElementById('main').innerText.includes('清除手動指定（1）')`), { fin, champ2 });
  await c.eval(`[...document.querySelectorAll('#main a')].find(a=>a.textContent.includes('清除手動指定')).click()`);
  await c.until(`!document.getElementById('main').innerText.includes('清除手動指定')`, 2000);
  ok('8.2 清除手動指定 → 冠軍回到模型推估', (await c.eval(`document.querySelector('.kchamp .kcn').textContent.trim()`)) !== fin);

  /* ───────────────────────── 9 設定＋蒙地卡羅模擬＋差異分析 ───────────────────────── */
  console.log('\n[9 設定、蒙地卡羅模擬、差異分析]');
  await c.eval(`document.querySelector('header .rl-btn').click()`);
  const setN = await n('#modal.show .set');
  ok('9.1 ⚙️ 設定視窗打開，有 13 項參數（主場、高原、僑民、球員權重、總進球、平手、攻防節奏、PK史、擾動、K值、敏感度、身價、模擬次數；實測 ' + setN + '）', setN === 13, setN);
  await c.eval(`(()=>{const s=document.querySelector('#modalBox select'); s.value='2000'; s.dispatchEvent(new Event('change')); return 1})()`);
  await c.eval(`[...document.querySelectorAll('#modalBox .btn')].find(b=>b.textContent.trim()==='完成').click()`);
  ok('9.2 模擬次數改成 2000 並關閉視窗', await c.until(`S.settings.sims===2000 && !document.getElementById('modal').classList.contains('show')`, 2000));
  await tab('analysis');
  await c.eval(`document.getElementById('simBtn').click()`);
  const simDone = await c.until(`!!simResult && [...document.querySelectorAll('#main .card h2')].some(h=>h.textContent.includes('模擬結果'))`, 60000, 300);
  const sim = await c.eval(`(()=>{const card=[...document.querySelectorAll('#main .card')].find(c=>(c.querySelector('h2')||{}).textContent && c.querySelector('h2').textContent.includes('模擬結果'));
    return [...card.querySelectorAll('table.sim tr')].slice(1).map(tr=>[...tr.querySelectorAll('td')].slice(1,7).map(td=>parseFloat(td.textContent)))})()`);
  const sums = [0, 1, 2, 3, 4, 5].map((k) => sim.reduce((s, r) => s + r[k], 0));
  const wantSums = [3200, 1600, 800, 400, 200, 100];
  ok('9.3 模擬完成，48 隊各一列（實測 ' + sim.length + '）', simDone && sim.length === 48, sim.length);
  ok('9.4 各階段機率加總＝出線 3200／16強 1600／8強 800／4強 400／決賽 200／冠軍 100％（實測 ' + sums.map((x) => x.toFixed(1)).join('／') + '）',
    sim.length === 48 && sums.every((x, k) => Math.abs(x - wantSums[k]) <= 2.5), sums);
  const nonMono = sim.filter((r) => !(r.every((x) => Number.isFinite(x) && x >= 0 && x <= 100) && r.every((x, k) => k === 0 || x <= r[k - 1] + 1e-9)));
  ok('9.5 每隊 出線≥16強≥8強≥4強≥決賽≥冠軍、無 NaN（樣本 ' + sim.length + ' 隊，違規 ' + nonMono.length + '）', sim.length === 48 && nonMono.length === 0, nonMono.slice(0, 3));
  const accTxt = await mainText();
  const ver = (accTxt.match(/已驗證\s*(\d+)\s*場/) || [])[1];
  ok('9.6 差異分析用了全部 13 場已完成比賽（實測「已驗證 ' + ver + ' 場」）', ver === '13', ver);
  ok('9.7 分析分頁整頁沒有 NaN／undefined', badWords(accTxt).length === 0, badWords(accTxt));

  /* ───────────────────────── 10 手動一鍵更新／天氣／名單（假資料） ───────────────────────── */
  console.log('\n[10 一鍵更新比分、查天氣、抓名單（假資料）]');
  await tab('sched');
  await c.eval(`[...document.querySelectorAll('.gfilter button')].find(b=>b.textContent==='全部').click()`);
  await c.until(`document.querySelectorAll('#main .match').length===72`, 3000);
  const nA2 = (await alerts()).length;
  await c.eval(`[...document.querySelectorAll('#main .btn')].find(b=>b.textContent.includes('一鍵更新比分')).click()`);
  await c.until(`window.__alerts.length > ${nA2}`, 6000);
  const upMsg = (await alerts()).slice(nA2).join(' / ');
  ok('10.1 一鍵更新：openfootball 新比分巴西 3-1 摩洛哥寫入，提示「從 openfootball＋ESPN 更新 1 場」（' + upMsg + '）',
    upMsg.includes('openfootball＋ESPN') && upMsg.includes('更新 1 場') && await c.eval(`JSON.stringify(S.results[5])==='[3,1]'`), upMsg);
  await c.eval(`document.querySelectorAll('#gm10 .wx')[0].click()`);
  await c.until(`(document.getElementById('wx10')||{}).textContent`, 4000);
  const wx = await c.eval(`document.getElementById('wx10').textContent`);
  ok('10.2 查天氣（假資料 31.4／34.6／20%）顯示「最高 31°C｜體感 35°C｜降雨 20%」（實測「' + wx + '」）', wx === '最高 31°C｜體感 35°C｜降雨 20%', wx);
  await c.eval(`[...document.querySelectorAll('#gm10 .wx')].find(b=>b.textContent.includes('名單')).click()`);
  await c.until(`(document.getElementById('lu10')||{}).textContent`, 4000);
  const lu = await c.eval(`document.getElementById('lu10').textContent`);
  ok('10.3 抓出賽名單：ESPN 找不到這場時有說明（實測「' + lu + '」）', lu.includes('ESPN 上找不到這場比賽'), lu);

  /* ───────────────────────── 11 對外連線全部被攔 ───────────────────────── */
  console.log('\n[11 對外連線（假資料模式）]');
  const extReq = [...new Set(c.requests.filter((u) => /^https:/i.test(u)))];
  const pausedSet = new Set(c.paused.map((p) => p.url));
  const leaked = extReq.filter((u) => !pausedSet.has(u));
  ok('11.1 假資料模式下沒有不認得的對外網址（攔到 ' + c.paused.length + ' 支）', c.paused.length >= 5 && c.unknown.length === 0, c.unknown.slice(0, 3));
  ok('11.2 每支對外請求都有被攔到、沒有漏網（外部請求 ' + extReq.length + ' 支）', extReq.length >= 5 && leaked.length === 0, leaked.slice(0, 3));
  const hostsSeen = [...new Set(c.paused.map((p) => new URL(p.url).hostname))].sort();
  ok('11.3 走查涵蓋到 ESPN／openfootball／Open-Meteo 三種來源（' + hostsSeen.join(', ') + '）',
    ['site.api.espn.com', 'raw.githubusercontent.com', 'api.open-meteo.com'].every((h) => hostsSeen.includes(h)), hostsSeen);

  /* ───────────────────────── 12 外部資料抓不到 ───────────────────────── */
  console.log('\n[12 外部資料全部失敗（ESPN／openfootball／天氣都連不上）]');
  const errBefore = c.errors.length;
  const pausedBefore = c.paused.length;
  const loadedF = await c.open(BASE, { net: 'fail' });
  await untilNode(() => c.paused.slice(pausedBefore).some((p) => p.url.includes('/news')) && c.paused.slice(pausedBefore).some((p) => p.url.includes('/scoreboard')), 8000);
  await sleep(800);
  const failReq = c.paused.slice(pausedBefore).filter((p) => p.mode === 'fail').map((p) => new URL(p.url).pathname.split('/').pop());
  ok('12.1 失敗模式下開啟時確實有去抓比分與新聞、且都失敗（' + JSON.stringify(failReq) + '）',
    failReq.includes('scoreboard') && failReq.includes('news'), failReq);
  ok('12.2 抓不到資料頁面照常顯示：31 場對陣、冠軍橫幅、無 NaN', loadedF && (await n('.kmatch')) === 31 && !!(await c.eval(`document.querySelector('.kchamp .kcn').textContent.trim()`)) && badWords(await mainText()).length === 0);
  ok('12.3 只用內建資料（4 場內建賽果、待審新聞 0 則、比分節流時間沒被寫）',
    await c.eval(`Object.keys(S.results).length===4 && S.pending.length===0 && !S.lastScoreTs && !S.lastNewsTs`),
    await c.eval(`[Object.keys(S.results).length, S.pending.length, S.lastScoreTs, S.lastNewsTs]`));
  ok('12.4 開啟時自動更新失敗是靜默的（沒有跳出對話框）', (await alerts()).length === 0, await alerts());
  await tab('news');
  ok('12.5 新聞分頁註明「尚未抓取」', (await mainText()).includes('尚未抓取'));
  await c.eval(`[...document.querySelectorAll('#main .btn')].find(b=>b.textContent.includes('抓取最新情報')).click()`);
  await c.until(`window.__alerts.length > 0`, 4000);
  const nfMsg = (await alerts()).join(' / ');
  ok('12.6 手動抓新聞失敗 → 提示「抓取失敗：請確認網路連線」（實測「' + nfMsg + '」）', nfMsg.includes('抓取失敗：請確認網路連線'), nfMsg);
  await tab('sched');
  const nA3 = (await alerts()).length;
  await c.eval(`[...document.querySelectorAll('#main .btn')].find(b=>b.textContent.includes('一鍵更新比分')).click()`);
  await c.until(`window.__alerts.length > ${nA3}`, 6000);
  const upFail = (await alerts()).slice(nA3).join(' / ');
  const btnState = await c.eval(`(()=>{const b=[...document.querySelectorAll('#main .btn')].find(b=>b.textContent.includes('一鍵更新')); return b? [b.textContent, b.disabled] : null})()`);
  ok('12.7 一鍵更新比分失敗 → 提示「更新失敗：請確認網路連線」，按鈕恢復可按（' + upFail + '｜' + JSON.stringify(btnState) + '）',
    upFail.includes('更新失敗：請確認網路連線') && !!btnState && btnState[0] === '🔄 一鍵更新比分' && btnState[1] === false, { upFail, btnState });
  await c.eval(`document.querySelectorAll('#gm10 .wx')[0].click()`);
  await c.until(`document.querySelectorAll('#gm10 .wx')[0].textContent.includes('失敗')`, 4000);
  const wxF = await c.eval(`document.querySelectorAll('#gm10 .wx')[0].textContent`);
  ok('12.8 查天氣失敗有說明（實測「' + wxF + '」）', wxF.includes('失敗（超過16天預報或離線）'), wxF);
  await c.eval(`[...document.querySelectorAll('#gm10 .wx')].find(b=>b.textContent.includes('名單')).click()`);
  await c.until(`(document.getElementById('lu10')||{}).textContent`, 4000);
  const luF = await c.eval(`document.getElementById('lu10').textContent`);
  ok('12.9 抓名單失敗有說明（實測「' + luF + '」）', luF.includes('抓取失敗（離線或 ESPN 介面變動）'), luF);
  ok('12.10 失敗模式整段沒有未捕捉的 JS 例外', c.errors.length === errBefore, c.errors.slice(errBefore, errBefore + 3));

  /* ───────────────────────── 13 版面：手機寬度、各分頁 ───────────────────────── */
  console.log('\n[13 版面：手機寬度沒有水平捲動（6 個分頁逐一檢查）]');
  const navCounts = [];
  for (const w of [360, 390]) {
    await c.width(w);
    await c.open(BASE);
    await sleep(500);
    navCounts.push(c.navs);
    const over = [];
    for (const key of ['ko', 'pred', 'teams', 'news', 'analysis', 'sched']) {
      await tab(key);
      await sleep(150);
      const [sw, iw] = await c.eval(`[document.documentElement.scrollWidth, window.innerWidth]`);
      if (sw > iw + 1) over.push({ key, sw, iw });
    }
    ok(`13.${w} ${w}px：6 個分頁整頁都沒有水平捲動`, over.length === 0, over);
  }
  ok('13.nav 已安裝 SW 後再開（' + navCounts.length + ' 次）每次導覽次數都＝1（實測 ' + JSON.stringify(navCounts) + '）',
    navCounts.length === 2 && navCounts.every((x) => x === 1), navCounts);

  console.log('\n[14 沒有錯誤]');
  ok('14.1 全程沒有未捕捉的 JS 例外（' + c.errors.length + ' 個）', c.errors.length === 0, c.errors.slice(0, 3));
} catch (e) {
  fail++;
  failed.push('測試程式本身出錯');
  console.log('  FAIL 測試程式本身出錯：' + (e && e.stack || e));
} finally {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '　通過 ' + pass + ' 項，失敗 ' + fail + ' 項' + (fail ? '：' + failed.join('｜') : ''));
  await cleanup();
  process.exit(fail ? 1 : 0);
}
