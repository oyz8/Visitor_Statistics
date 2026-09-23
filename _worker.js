// ============================================================
// 访客统计 Worker —— Cloudflare Pages + D1 + GitHub + Telegram
// ============================================================

// ---------- 常量 ----------
const PUSH_COOLDOWN_SEC = 60;
const STATS_DAYS        = 365;
const GIT_DIR           = 'public/pic';
const JWT_EXPIRES_SEC   = 8 * 3600;

const MAX_BODY_BYTES    = 100 * 1024 * 1024;  // 请求体上限 100MB
const MAX_IMAGE_BYTES   =   8 * 1024 * 1024;  // 单图上限 8MB
const MAX_ITEMS         = 50;                 // 单次保存最多 50 条
const UPLOAD_CONCURRENCY = 5;                 // GitHub 上传并发上限

const MEMORY_MAX        = 10_000;
const MEMORY_TTL_MS     = 10 * 60 * 1000;

const TZ_OFFSET_MS      = 8 * 3600 * 1000;

const PANEL_ID  = '_panel';
const PANEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">'
  + '<stop offset="0%" stop-color="#14b8a6"/>'
  + '<stop offset="100%" stop-color="#0891b2"/>'
  + '</linearGradient></defs>'
  + '<rect width="32" height="32" rx="8" ry="8" fill="url(#g)"/>'
  + '<g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/></g></svg>';

const ID_RE  = /^[A-Za-z0-9_-]{1,64}$/;
const PIC_RE = /^\/([^/.]+)\.(png|svg|jpg|jpeg|gif|webp)$/i;

// 敏感文件禁止访问
const BLOCK_PATHS = new Set([
  '/README.md', '/readme.md',
  '/_worker.js', '/_headers', '/_redirects',
  '/wrangler.toml', '/wrangler.jsonc', '/wrangler.json',
  '/package.json', '/package-lock.json', '/pnpm-lock.yaml', '/yarn.lock',
  '/.gitignore', '/.env', '/.env.example',
]);

const BOT_RE = /bot|spider|crawl|slurp|wget|curl|python-requests|postman|headless|phantom|puppeteer|playwright|itdog|boce|17ce|ping\.pe|ce8\.com|monitor|probe|uptime|checker/i;
const REFERER_BLOCK_RE = /itdog\.cn|boce\.com|17ce\.com|ping\.pe|ce8\.com|chinaz\.com|webkaka/i;
const OLD_CHROME_THRESHOLD = 100;

// ---------- 内存冷却 ----------
const memoryCooldown = new Map();

function memoryPeek(key, ttlMs) {
  const last = memoryCooldown.get(key);
  return !(last && Date.now() - last < ttlMs);
}

function memorySet(key) {
  memoryCooldown.set(key, Date.now());
  if (memoryCooldown.size <= MEMORY_MAX) return;
  const now = Date.now();
  for (const [k, v] of memoryCooldown) {
    if (now - v > MEMORY_TTL_MS) memoryCooldown.delete(k);
  }
  if (memoryCooldown.size > MEMORY_MAX) {
    const excess = Math.ceil(MEMORY_MAX * 0.2);
    let count = 0;
    for (const k of memoryCooldown.keys()) {
      if (count++ >= excess) break;
      memoryCooldown.delete(k);
    }
  }
}

// ---------- 工具函数 ----------
function ipSegment(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const p = ip.split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') : ip;
}

function isBotRequest(request) {
  const ua       = request.headers.get('User-Agent') || '';
  const referer  = request.headers.get('Referer') || request.headers.get('Origin') || '';
  const pathname = new URL(request.url).pathname;

  if (BOT_RE.test(ua))                return { bot: true, reason: 'bot-ua' };
  if (REFERER_BLOCK_RE.test(referer)) return { bot: true, reason: 'bot-referer' };

  const m = ua.match(/Chrome\/(\d+)\./i);
  if (m && parseInt(m[1], 10) < OLD_CHROME_THRESHOLD)
    return { bot: true, reason: 'old-chrome-' + m[1] };

  if (referer && referer.includes(pathname))
    return { bot: true, reason: 'self-referer' };

  return { bot: false };
}

function escapeLike(s) {
  return s.replace(/[%_\\]/g, c => '\\' + c);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year:  'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function todayShanghai() {
  return formatDate(new Date());
}

function countryCodeToEmoji(code) {
  if (!code || code.length !== 2) return '';
  const OFF = 0x1F1E6 - 'A'.charCodeAt(0);
  return [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + OFF)).join('');
}

function formatBytes(n) {
  if (n < 1024)    return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('svg'))                       return 'svg';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif'))                       return 'gif';
  if (m.includes('webp'))                      return 'webp';
  return 'png';
}

// 检测图片真实类型（魔数 + SVG 首标签）
function detectImageType(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8)                                           return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024));
  if (/<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// 支持 charset 的 dataURL
function parseBase64Image(raw) {
  const m = String(raw).match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
  return m
    ? { mime: m[1] || 'image/png', base64Data: m[2] }
    : { mime: 'image/png',         base64Data: raw  };
}

function base64ToBytes(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function sha256Short(bytes, len = 8) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function getPanelUrl(request) {
  try { return new URL(request.url).origin; } catch { return ''; }
}

// 并发受限映射
async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let idx = 0;
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      try { ret[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (e) { ret[i] = { status: 'rejected', reason: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return ret;
}

// ---------- UA 解析（iPad 优先于手机）----------
const BROWSER_RULES = [
  [/QQBrowser\/([\d.]+)/,    v => `QQ浏览器 ${v}`],
  [/UCBrowser\/([\d.]+)/,    v => `UC浏览器 ${v}`],
  [/Edg\/([\d.]+)/,          v => `Edge ${v}`],
  [/Chrome\/([\d.]+)/,       v => `Chrome ${v}`],
  [/Firefox\/([\d.]+)/,      v => `Firefox ${v}`],
  [/Safari\/([\d.]+)/,       v => `Safari ${v}`],
  [/MSIE\s([\d.]+)/,         v => `IE ${v}`],
  [/Trident\/.*rv:([\d.]+)/, v => `IE ${v}`],
];
const OS_RULES = [
  [/Windows NT 10/,   'Windows 10'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Mac OS X/,        'macOS'],
  [/Android/,         'Android'],
  [/iPhone|iPad/,     'iOS'],
  [/Linux/,           'Linux'],
];
const ENGINE_RULES = [
  [/AppleWebKit\/([\d.]+)/, v => `AppleWebKit/${v}`],
  [/Gecko\//,               ()  => 'Gecko'],
  [/Trident\/([\d.]+)/,     v => `Trident/${v}`],
];

function parseUA(ua) {
  let device = 'PC';
  if (/iPad|Tablet/i.test(ua)) device = '平板';
  else if (/Mobile|Android|iPhone|BlackBerry|IEMobile|Silk/i.test(ua)) device = '手机';

  const matchFirst = (rules, fallback) => {
    for (const [re, fmt] of rules) {
      const r = ua.match(re);
      if (r) return typeof fmt === 'function' ? fmt(r[1]) : fmt;
    }
    return fallback;
  };
  return {
    device,
    os:      matchFirst(OS_RULES,      '未知系统'),
    browser: matchFirst(BROWSER_RULES, '未知浏览器'),
    engine:  matchFirst(ENGINE_RULES,  '未知内核'),
  };
}

// ---------- JWT ----------
function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function jwtSign(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64urlEncode(sigBuf)}`;
}

async function jwtVerify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key,
    b64urlDecode(sig), enc.encode(`${header}.${body}`));
  if (!valid) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); }
  catch { return null; }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// 严格：必须有密钥
function jwtSecret(env) {
  const base = env.JWT_SECRET || env.PASSWORD;
  if (!base || base.length < 4) throw new Error('未配置 JWT_SECRET / PASSWORD（至少 4 字符）');
  return base + ':cf-visitor-stat-jwt-v1';
}

// ---------- 恒定时间比较 ----------
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab  = enc.encode(a);
  const bb  = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  const pa  = new Uint8Array(len);
  const pb  = new Uint8Array(len);
  pa.set(ab);
  pb.set(bb);
  let r = 0;
  for (let i = 0; i < len; i++) r |= pa[i] ^ pb[i];
  r |= ab.length ^ bb.length;
  return r === 0;
}

// ---------- GitHub ----------
function sanitizeEnv(s) {
  return String(s ?? '').trim().replace(/[\r\n\t\x00-\x1F]+/g, '');
}

function gitConfig(env) {
  const token  = sanitizeEnv(env.GITHUB_TOKEN);
  const repo   = sanitizeEnv(env.REPO_NAME);
  const branch = sanitizeEnv(env.BRANCH) || 'main';
  if (!token) throw new Error('缺少 GITHUB_TOKEN');
  if (!/^(ghp_|github_pat_|ghs_|gho_|ghu_)[A-Za-z0-9_]+$/.test(token))
    throw new Error('GITHUB_TOKEN 格式不合法');
  if (!repo) throw new Error('缺少 REPO_NAME');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('REPO_NAME 格式错误');
  const safeBranch = branch.replace(/[^A-Za-z0-9_.\-/]/g, '');
  if (!safeBranch) throw new Error('BRANCH 名称非法');
  return { token, repo, branch: safeBranch };
}

function gitHeaders(token) {
  return {
    'Authorization':        `Bearer ${token}`,
    'User-Agent':           'cf-visitor-stat',
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function gitPutBinary(env, path, bytes, message) {
  const cfg  = gitConfig(env);
  const api  = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const hdrs = gitHeaders(cfg.token);

  let sha;
  const getResp = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers: hdrs });
  if (getResp.ok) {
    const j = await getResp.json().catch(() => null);
    sha = j?.sha;
  } else if (getResp.status !== 404) {
    const t = await getResp.text().catch(() => '');
    throw new Error(`GitHub GET ${path}: ${getResp.status} ${t.slice(0, 120)}`);
  }

  const bodyObj = { message, content: bytesToBase64(bytes), branch: cfg.branch };
  if (sha) bodyObj.sha = sha;

  const putResp = await fetch(api, {
    method:  'PUT',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body:    JSON.stringify(bodyObj),
  });
  if (!putResp.ok) {
    const t = await putResp.text().catch(() => '');
    throw new Error(`GitHub PUT ${path}: ${putResp.status} ${t.slice(0, 120)}`);
  }
  return putResp.json();
}

async function gitDelete(env, path, message) {
  const cfg  = gitConfig(env);
  const api  = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const hdrs = gitHeaders(cfg.token);

  const getResp = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers: hdrs });
  if (getResp.status === 404) return null;
  if (!getResp.ok) {
    const t = await getResp.text().catch(() => '');
    throw new Error(`GitHub GET ${path}: ${getResp.status} ${t.slice(0, 120)}`);
  }
  const { sha } = await getResp.json();

  const delResp = await fetch(api, {
    method:  'DELETE',
    headers: { ...hdrs, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, sha, branch: cfg.branch }),
  });
  if (!delResp.ok) {
    const t = await delResp.text().catch(() => '');
    throw new Error(`GitHub DELETE ${path}: ${delResp.status} ${t.slice(0, 120)}`);
  }
  return true;
}

// ---------- D1 ----------
async function readIndex(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT identifier, name, file, ext, mime, size, hash
       FROM img_index
       ORDER BY sort_order ASC, identifier ASC`
    ).all();
    return Array.isArray(results) ? results : [];
  } catch (e) {
    console.error('[readIndex]', e);
    return [];
  }
}

async function readIndexItem(env, identifier) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT identifier, name, file, ext, mime, size, hash
       FROM img_index WHERE identifier = ? LIMIT 1`
    ).bind(identifier).all();
    return results?.[0] ?? null;
  } catch (e) {
    console.error('[readIndexItem]', e);
    return null;
  }
}

async function writeIndexToD1(env, newIndex) {
  const stmts = [];
  if (newIndex.length === 0) {
    stmts.push(env.DB.prepare('DELETE FROM img_index'));
  } else {
    const placeholders = newIndex.map(() => '?').join(',');
    stmts.push(
      env.DB.prepare(`DELETE FROM img_index WHERE identifier NOT IN (${placeholders})`)
        .bind(...newIndex.map(x => x.identifier))
    );
  }
  const now = Date.now();
  for (let i = 0; i < newIndex.length; i++) {
    const item = newIndex[i];
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO img_index
           (identifier, name, file, ext, mime, size, hash, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.identifier, item.name || '', item.file,
        item.ext || '', item.mime || '', item.size || 0,
        item.hash || '', i, now
      )
    );
  }
  const results = await env.DB.batch(stmts);
  const failed = results.filter(r => !r.success);
  if (failed.length) throw new Error(`D1 batch 有 ${failed.length} 条语句失败`);
}

// ---------- 统计（修复：不再双重偏移）----------
async function getStats(env, index = null) {
  const now   = Date.now();
  const dates = [];
  for (let i = 0; i < STATS_DAYS; i++) {
    dates.push(formatDate(new Date(now - i * 86400000)));
  }
  const minDate = dates[dates.length - 1];
  const maxDate = dates[0];

  const { results } = await env.DB.prepare(
    `SELECT date, identifier, count FROM daily_summary WHERE date >= ? AND date <= ?`
  ).bind(minDate, maxDate).all();

  const totalByDate  = {};
  const byIdentifier = {};
  const idSet        = new Set();
  for (const d of dates) totalByDate[d] = 0;

  for (const row of results) {
    totalByDate[row.date] = (totalByDate[row.date] || 0) + row.count;
    if (!byIdentifier[row.identifier]) byIdentifier[row.identifier] = {};
    byIdentifier[row.identifier][row.date] = row.count;
    idSet.add(row.identifier);
  }

  const resolvedIndex = index ?? await readIndex(env);
  for (const item of resolvedIndex) idSet.add(item.identifier);

  for (const id of idSet) {
    if (!byIdentifier[id]) byIdentifier[id] = {};
    for (const d of dates) {
      if (byIdentifier[id][d] === undefined) byIdentifier[id][d] = 0;
    }
  }

  return {
    dates: [...dates].reverse(),
    totalByDate,
    byIdentifier,
    identifiers: [...idSet].sort(),
  };
}

// ---------- 响应 ----------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':  'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
function notFound()     { return new Response('Not Found', { status: 404 }); }
function unauthorized() { return jsonResponse({ ok: false, error: '未授权' }, 401); }

// ---------- 入口 ----------
export default {
  async fetch(request, env, ctx) {
    try {
      const { pathname } = new URL(request.url);

      // 敏感文件拦截
      if (BLOCK_PATHS.has(pathname) || pathname.startsWith('/.git/') || pathname.startsWith('/.')) {
        return notFound();
      }

      // API
      if (pathname.startsWith('/api/')) {
        try {
          return await handleApi(request, env, ctx, pathname.slice(5));
        } catch (e) {
          console.error('[api error]', e?.stack || e);
          return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
        }
      }

      // 追踪图片
      const m = pathname.match(PIC_RE);
      if (m) {
        try {
          return await handleVisit(request, env, ctx, m[1]);
        } catch (e) {
          console.error('[visit error]', e?.stack || e);
          return notFound();
        }
      }

      // 其他静态资源
      if (env.ASSETS) {
        try {
          return await env.ASSETS.fetch(request);
        } catch (e) {
          console.error('[assets error]', e?.stack || e);
          return notFound();
        }
      }
      return notFound();
    } catch (e) {
      console.error('[top error]', e?.stack || e);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

// ---------- API 路由 ----------
async function handleApi(request, env, ctx, sub) {
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
        'Access-Control-Max-Age':       '86400',
      },
    });
  }

  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (cl > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: `请求体超出限制（${formatBytes(MAX_BODY_BYTES)}）` }, 413);
    }
  }

  if (sub === 'login' && method === 'POST') return handleLogin(request, env);

  const payload = await checkAuth(request, env);
  if (!payload) return unauthorized();

  if (sub === 'init'   && method === 'GET')  return handleInitCheck(env);
  if (sub === 'init'   && method === 'POST') return handleInitRun(env);
  if (sub === 'data'   && method === 'GET')  return handleData(env);
  if (sub === 'logs'   && method === 'GET')  return handleLogs(request, env);
  if (sub === 'hours'  && method === 'GET')  return handleHourly(request, env);
  if (sub === 'images' && method === 'POST') return handleSaveImages(request, env);
  if (sub === 'deploy' && method === 'POST') return handleDeploy(env);

  return notFound();
}

// ---------- 鉴权 ----------
async function checkAuth(request, env) {
  const token = request.headers.get('X-Auth-Token') || '';
  if (!token) return null;
  return jwtVerify(token, jwtSecret(env));
}

async function handleLogin(request, env) {
  // 强制要求配置 PASSWORD
  if (!env.PASSWORD) {
    return jsonResponse({ ok: false, error: '服务端未配置 PASSWORD，禁止登录' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: '格式错误' }, 400); }

  if (typeof body.password !== 'string' || !constantTimeEqual(body.password, env.PASSWORD)) {
    return jsonResponse({ ok: false, error: '密码错误' }, 401);
  }

  const now   = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { sub: 'admin', iat: now, exp: now + JWT_EXPIRES_SEC },
    jwtSecret(env)
  );
  return jsonResponse({ ok: true, token });
}

// ---------- 初始化 ----------
async function handleInitCheck(env) {
  try {
    await env.DB.prepare('SELECT 1 FROM visits        LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM daily_summary LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM img_index     LIMIT 1').all();
    return jsonResponse({ ok: true, initialized: true });
  } catch (e) {
    return jsonResponse({ ok: true, initialized: false, reason: e.message });
  }
}

async function handleInitRun(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL,
      ts INTEGER NOT NULL,
      visit_date TEXT NOT NULL,
      ip TEXT, country TEXT, region TEXT, city TEXT, isp TEXT,
      ua TEXT, device TEXT, os TEXT, browser TEXT, engine TEXT,
      referer TEXT, is_bot INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits(visit_date DESC, ts DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_id_date ON visits(identifier, visit_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_ip      ON visits(ip)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_ts      ON visits(ts)`,
    `CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT NOT NULL, identifier TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, identifier)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_summary_date ON daily_summary(date DESC)`,
    `CREATE TABLE IF NOT EXISTS img_index (
      identifier TEXT PRIMARY KEY, name TEXT, file TEXT NOT NULL,
      ext TEXT, mime TEXT, size INTEGER, hash TEXT,
      sort_order INTEGER DEFAULT 0, updated_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_img_order ON img_index(sort_order ASC, identifier ASC)`,
  ];

  const results = [];
  for (let i = 0; i < statements.length; i++) {
    try {
      await env.DB.prepare(statements[i]).run();
      results.push({ index: i, ok: true });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message || String(e) });
    }
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    return jsonResponse({ ok: false, error: `有 ${failed.length} 条语句执行失败`, results }, 500);
  }

  try {
    await env.DB.prepare('SELECT 1 FROM visits        LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM daily_summary LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM img_index     LIMIT 1').all();
    return jsonResponse({ ok: true, message: '数据库初始化完成', results });
  } catch (e) {
    return jsonResponse({ ok: false, error: '建表后验证失败: ' + e.message, results }, 500);
  }
}

// ---------- 数据 ----------
async function handleData(env) {
  const index = await readIndex(env);
  const stats = await getStats(env, index);
  return jsonResponse({ ok: true, images: index, stats });
}

// ---------- 今日 24 小时 ----------
async function handleHourly(request, env) {
  const url        = new URL(request.url);
  const identifier = url.searchParams.get('identifier') || '';

  const now        = Date.now();
  const localNow   = new Date(now + TZ_OFFSET_MS);
  const todayStart = Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(),
    0, 0, 0, 0
  ) - TZ_OFFSET_MS;
  const todayEnd   = todayStart + 86_400_000;

  const conds  = ['ts >= ?', 'ts < ?', 'is_bot = 0'];
  const params = [todayStart, todayEnd];
  if (identifier) { conds.push('identifier = ?'); params.push(identifier); }
  const where = 'WHERE ' + conds.join(' AND ');

  try {
    const { results } = await env.DB.prepare(
      `SELECT CAST(((ts + ${TZ_OFFSET_MS}) % 86400000) / 3600000 AS INTEGER) AS hour,
              COUNT(*) AS cnt
       FROM visits ${where}
       GROUP BY hour`
    ).bind(...params).all();

    const buckets = new Array(24).fill(0);
    for (const row of results) {
      if (row.hour >= 0 && row.hour < 24) buckets[row.hour] = row.cnt;
    }
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');
    return jsonResponse({ ok: true, hours, counts: buckets });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// ---------- 日志 ----------
async function handleLogs(request, env) {
  const url        = new URL(request.url);
  const date       = url.searchParams.get('date')       || '';
  const identifier = url.searchParams.get('identifier') || '';
  const ip         = url.searchParams.get('ip')         || '';
  const includeBot = url.searchParams.get('bot') === '1';
  const page       = Math.max(1,   parseInt(url.searchParams.get('page')     || '1',  10));
  const pageSize   = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pageSize') || '50', 10)));

  const conds  = [];
  const params = [];

  if (date)       { conds.push('visit_date = ?'); params.push(date); }
  if (identifier) { conds.push('identifier = ?'); params.push(identifier); }
  if (ip) {
    conds.push("ip LIKE ? ESCAPE '\\'");
    params.push('%' + escapeLike(ip.trim()) + '%');
  }
  if (!includeBot) conds.push('is_bot = 0');

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM visits ${where}`
  ).bind(...params).all();
  const total = cnt[0]?.n || 0;

  const offset = (page - 1) * pageSize;
  const { results: items } = await env.DB.prepare(
    `SELECT id, identifier, ts, visit_date, ip, country, region, city, isp,
            device, os, browser, engine, referer, is_bot
     FROM visits ${where}
     ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all();

  return jsonResponse({ ok: true, total, page, pageSize, items });
}

// ---------- 保存图片（有序数组 + 魔数校验）----------
async function handleSaveImages(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: '格式错误' }, 400); }

  // 兼容两种格式：新 items 数组 / 旧 images+keep
  let items;
  if (Array.isArray(body.items)) {
    items = body.items;
  } else {
    const uploads = Array.isArray(body.images) ? body.images : [];
    const keeps   = Array.isArray(body.keep)   ? body.keep   : [];
    items = [
      ...keeps.map(k => ({ action: 'keep', identifier: k.identifier, name: k.name })),
      ...uploads.map(u => ({ action: 'upload', identifier: u.identifier, name: u.name, base64: u.base64 })),
    ];
  }

  if (items.length > MAX_ITEMS) {
    return jsonResponse({ ok: false, error: `总条目不能超过 ${MAX_ITEMS}` }, 400);
  }

  // 校验
  const seen = new Set();
  for (const it of items) {
    if (typeof it.identifier !== 'string' || !ID_RE.test(it.identifier))
      return jsonResponse({ ok: false, error: `非法标识符：${it.identifier || '(空)'}` }, 400);
    if (it.identifier === PANEL_ID)
      return jsonResponse({ ok: false, error: `"${PANEL_ID}" 是系统保留标识符` }, 400);
    if (seen.has(it.identifier))
      return jsonResponse({ ok: false, error: `标识符重复：${it.identifier}` }, 400);
    seen.add(it.identifier);
    if (it.action === 'upload' && (typeof it.base64 !== 'string' || !it.base64))
      return jsonResponse({ ok: false, error: `${it.identifier} 缺少图片数据` }, 400);
    if (it.action !== 'keep' && it.action !== 'upload')
      return jsonResponse({ ok: false, error: `${it.identifier} action 非法` }, 400);
  }

  // 读取旧索引
  const oldIndex = await readIndex(env);
  const oldMap   = new Map(oldIndex.map(x => [x.identifier, x]));

  const newIndex = [], toDelete = [], toUpload = [];

  // 按 items 顺序处理
  for (const it of items) {
    if (it.action === 'keep') {
      const old = oldMap.get(it.identifier);
      if (!old || !old.file) {
        return jsonResponse({ ok: false, error: `${it.identifier} 在服务器上没有图片，请重新上传` }, 400);
      }
      newIndex.push({
        identifier: it.identifier,
        name:       String(it.name || old.name || '').slice(0, 100),
        file:       old.file, ext: old.ext, mime: old.mime,
        size:       old.size, hash: old.hash,
      });
      continue;
    }

    // upload
    const { mime, base64Data } = parseBase64Image(it.base64);
    let bytes;
    try { bytes = base64ToBytes(base64Data); }
    catch { return jsonResponse({ ok: false, error: `${it.identifier} base64 数据损坏` }, 400); }

    if (bytes.length === 0)
      return jsonResponse({ ok: false, error: `${it.identifier} 图片为空` }, 400);
    if (bytes.length > MAX_IMAGE_BYTES)
      return jsonResponse({ ok: false, error: `${it.identifier} 图片过大（>${formatBytes(MAX_IMAGE_BYTES)}）` }, 400);

    // MIME 必须为 image/*
    if (!/^image\//i.test(mime)) {
      return jsonResponse({ ok: false, error: `${it.identifier} MIME 类型非法：${mime}` }, 400);
    }

    // 魔数校验
    const detected = detectImageType(bytes);
    if (!detected) {
      return jsonResponse({ ok: false, error: `${it.identifier} 无法识别为有效图片` }, 400);
    }
    const declaredExt = mimeToExt(mime);
    if (detected !== declaredExt) {
      return jsonResponse({
        ok: false,
        error: `${it.identifier} 文件内容（${detected}）与声明的类型（${declaredExt}）不匹配`,
      }, 400);
    }

    const fileName = `${it.identifier}.${detected}`;
    const filePath = `${GIT_DIR}/${fileName}`;
    const hash     = await sha256Short(bytes, 8);

    const old = oldMap.get(it.identifier);
    if (old && old.file && old.file !== fileName) {
      toDelete.push(`${GIT_DIR}/${old.file}`);
    }

    toUpload.push({ path: filePath, bytes, message: `update: ${it.identifier}.${detected}` });
    newIndex.push({
      identifier: it.identifier,
      name:       String(it.name || '').slice(0, 100),
      file:       fileName, ext: detected, mime,
      size:       bytes.length, hash,
    });
  }

  // 被整体删除的旧图
  const newIds = new Set(newIndex.map(x => x.identifier));
  for (const old of oldIndex) {
    if (!newIds.has(old.identifier) && old.file) {
      toDelete.push(`${GIT_DIR}/${old.file}`);
    }
  }

  // 上传（限制并发）
  if (toUpload.length) {
    const uploadResults = await mapLimit(toUpload, UPLOAD_CONCURRENCY,
      u => gitPutBinary(env, u.path, u.bytes, u.message));
    const uploadFailed = uploadResults
      .map((r, i) => r.status === 'rejected'
        ? { path: toUpload[i].path, error: r.reason?.message || String(r.reason) }
        : null)
      .filter(Boolean);
    if (uploadFailed.length) {
      return jsonResponse({
        ok: false,
        error: `有 ${uploadFailed.length} 张图片上传到 Git 失败`,
        details: uploadFailed,
      }, 500);
    }
  }

  // 写 D1 索引
  try {
    await writeIndexToD1(env, newIndex);
  } catch (e) {
    console.error('[D1 writeIndex failed]', e);
    return jsonResponse({ ok: false, error: '保存索引失败：' + e.message }, 500);
  }

  // 清理旧图（限制并发）
  let deleted = 0;
  const deleteErrors = [];
  if (toDelete.length) {
    const delResults = await mapLimit(toDelete, UPLOAD_CONCURRENCY,
      p => gitDelete(env, p, 'cleanup: remove obsolete image'));
    delResults.forEach((r, i) => {
      if (r.status === 'fulfilled') deleted++;
      else deleteErrors.push({
        path: toDelete[i],
        error: r.reason?.message || String(r.reason),
      });
    });
    if (deleteErrors.length) console.warn('[gitDelete partial failure]', deleteErrors);
  }

  return jsonResponse({
    ok: true, count: newIndex.length, uploaded: toUpload.length, deleted,
    deleteErrors: deleteErrors.length ? deleteErrors : undefined,
    index: newIndex,
  });
}

// ---------- 部署 ----------
async function handleDeploy(env) {
  const hookUrl = env.CF_DEPLOY_HOOK_URL;
  if (!hookUrl) return jsonResponse({ ok: false, error: '未配置 CF_DEPLOY_HOOK_URL' }, 500);
  try {
    const resp = await fetch(hookUrl, { method: 'POST' });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return jsonResponse({ ok: false, error: `Hook 返回 ${resp.status}: ${t.slice(0, 120)}` }, 502);
    }
    return jsonResponse({ ok: true, message: '部署已触发' });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message || String(e) }, 502);
  }
}

// ---------- 图片访问 ----------
async function handleVisit(request, env, ctx, identifier) {
  // 方法限制
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Allow': 'GET, HEAD' },
    });
  }

  if (!ID_RE.test(identifier)) return notFound();

  const botCheck = isBotRequest(request);

  // 内置追踪点
  if (identifier === PANEL_ID) {
    ctx.waitUntil(
      trackVisit(request, env, identifier, null, botCheck.bot ? 1 : 0)
        .catch(e => console.error('[panel track failed]', e?.stack || e))
    );
    const svgBytes = new TextEncoder().encode(PANEL_SVG);
    return new Response(svgBytes, {
      status: 200,
      headers: {
        'Content-Type':                'image/svg+xml; charset=utf-8',
        'Cache-Control':               'no-store, no-cache, must-revalidate',
        'Content-Length':              String(svgBytes.length),
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options':      'nosniff',
      },
    });
  }

  // 普通图片
  const item = await readIndexItem(env, identifier);
  if (!item || !item.file) return notFound();

  // 先取图，成功才统计
  const resp = await serveImage(request, env, item);
  if (resp.ok) {
    ctx.waitUntil(
      trackVisit(request, env, identifier, item, botCheck.bot ? 1 : 0)
        .catch(e => console.error('[track failed]', e?.stack || e))
    );
  }
  return resp;
}

async function serveImage(request, env, item) {
  if (!env.ASSETS) {
    console.error('[serveImage] env.ASSETS undefined');
    return notFound();
  }

  const assetUrl = new URL(`/public/pic/${item.file}`, request.url).toString();
  let assetResp;
  try {
    assetResp = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
  } catch (e) {
    console.error('[serveImage] ASSETS.fetch error:', e);
    return notFound();
  }

  if (!assetResp.ok) return notFound();
  if ((assetResp.headers.get('Content-Type') || '').includes('text/html')) return notFound();

  const headers = new Headers({
    'Content-Type':                assetResp.headers.get('Content-Type') || `image/${item.ext || 'png'}`,
    'Cache-Control':               'public, max-age=300, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'X-Tracker':                   item.identifier,
    'X-Content-Type-Options':      'nosniff',
  });

  // SVG 沙箱
  if (item.ext === 'svg') {
    headers.set('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }

  if (item.hash) headers.set('ETag', `"${item.hash}"`);
  const cl = assetResp.headers.get('Content-Length');
  if (cl) headers.set('Content-Length', cl);

  return new Response(assetResp.body, { status: 200, headers });
}

// ---------- 记录访问 ----------
async function trackVisit(request, env, identifier, item, isBot) {
  const ip      = request.headers.get('CF-Connecting-IP') || 'Unknown';
  const ua      = request.headers.get('User-Agent') || '';
  const referer = request.headers.get('Referer')
               || request.headers.get('Origin')
               || request.url;
  const cf      = request.cf || {};
  const { os, browser, engine, device } = parseUA(ua);
  const now  = Date.now();
  const date = todayShanghai();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO visits
         (identifier, ts, visit_date, ip, country, region, city, isp, ua,
          device, os, browser, engine, referer, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      identifier, now, date, ip,
      cf.country || '', cf.region || '', cf.city || '', cf.asOrganization || '',
      ua.slice(0, 500), device, os, browser, engine,
      referer.slice(0, 500), isBot
    ),
  ];

  // 只有非 bot 才累加到 daily_summary
  if (!isBot) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO daily_summary (date, identifier, count) VALUES (?, ?, 1)
         ON CONFLICT(date, identifier) DO UPDATE SET count = count + 1`
      ).bind(date, identifier)
    );
  }

  try { await env.DB.batch(stmts); }
  catch (e) { console.error('[D1 write failed]', e?.message || e); }

  // 非 bot 才推送
  if (!isBot) {
    const itemName = item?.name ?? null;
    try {
      await maybeNotify(request, env, identifier,
        { ip, ua, cf, referer, os, browser, engine, device, itemName });
    } catch (e) {
      console.error('[notify failed]', e?.stack || e);
    }
  }
}

// ---------- Telegram ----------
async function maybeNotify(request, env, identifier, info) {
  if (!env.TG_TOKEN || !env.TG_ID) return;

  const ttlMs  = PUSH_COOLDOWN_SEC * 1000;
  const ipKey  = `ip:${info.ip}`;
  const segKey = `seg:${ipSegment(info.ip)}`;

  if (!memoryPeek(ipKey,  ttlMs)) return;
  if (!memoryPeek(segKey, ttlMs)) return;
  memorySet(ipKey);
  memorySet(segKey);

  let idToday = 1, totalToday = 1;
  const today = todayShanghai();
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         (SELECT count FROM daily_summary WHERE date = ? AND identifier = ?) AS idToday,
         (SELECT SUM(count) FROM daily_summary WHERE date = ?)               AS totalToday`
    ).bind(today, identifier, today).all();
    idToday    = results[0]?.idToday    || 1;
    totalToday = results[0]?.totalToday || 1;
  } catch (e) { console.error('[D1 count]', e); }

  const name = identifier === PANEL_ID
    ? '🟢 管理面板'
    : (info.itemName || identifier);

  const flag     = countryCodeToEmoji(info.cf.country || '');
  const location = [info.cf.country, info.cf.region, info.cf.city].filter(Boolean).join(' ') || '未知';
  const nowStr   = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const mEsc = (s, max = 80) => {
    let x = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    if (x.length > max) x = x.slice(0, max - 1) + '…';
    return x.replace(/([*_`[\]])/g, '\\$1');
  };

  const L = {
    id: '标    识', ip: 'IP地址', geo: '归属地', isp: '运营商',
    ref: '来    源', dev: '设    备', brw: '浏览器', day: '今    日', time: '时    间',
  };

  const message =
    '🔰 *访客累计：' + totalToday + '*\n\n' +
    '*来源信息*\n' +
    '· ' + L.id  + '：' + mEsc(name, 40)                              + '\n' +
    '· ' + L.ip  + '：`' + mEsc(info.ip, 50)                         + '`\n' +
    '· ' + L.geo + '：' + flag + ' ' + mEsc(location, 50)            + '\n' +
    '· ' + L.isp + '：' + mEsc(info.cf.asOrganization || '未知', 40) + '\n' +
    '· ' + L.ref + '：`' + mEsc(info.referer || '—', 60)             + '`\n\n' +
    '*设备指纹*\n' +
    '· ' + L.dev + '：' + mEsc(info.device, 20) + ' · ' + mEsc(info.os, 40)      + '\n' +
    '· ' + L.brw + '：' + mEsc(info.browser, 40) + ' · ' + mEsc(info.engine, 40) + '\n\n' +
    '· ' + L.day  + '：' + idToday    + ' 次\n' +
    '· ' + L.time + '：' + nowStr;

  const payload = {
    chat_id:                  env.TG_ID,
    text:                     message,
    parse_mode:               'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: '👤 管理仪表盘', url: getPanelUrl(request) }]],
    },
  };

  await sendTelegram(payload, env.TG_TOKEN);
}

async function sendTelegram(payload, token) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.error('[Telegram]', resp.status, t.slice(0, 200));
  }
}
