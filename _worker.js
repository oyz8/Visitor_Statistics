// 常量
const PUSH_COOLDOWN_SEC = 60;
const STATS_DAYS        = 365;
const GIT_DIR           = 'public/pic';

const PANEL_ID = '_panel';
const PANEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14b8a6"/><stop offset="100%" stop-color="#0891b2"/></linearGradient></defs><rect width="32" height="32" rx="8" ry="8" fill="url(#g)"/><g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></g></svg>';

const ID_RE  = /^[A-Za-z0-9_-]{1,64}$/;
const PIC_RE = /^\/([^/.]+)\.(png|svg|jpg|jpeg|gif|webp)$/i;

// 已知 bot / 测速工具 UA 关键字
const BOT_RE = /bot|spider|crawl|slurp|wget|curl|python-requests|postman|headless|phantom|puppeteer|playwright|itdog|boce|17ce|ping\.pe|ce8\.com|monitor|probe|uptime|checker/i;
// 测速网站 Referer 黑名单
const REFERER_BLOCK_RE = /itdog\.cn|boce\.com|17ce\.com|ping\.pe|ce8\.com|chinaz\.com|webkaka/i;
// 老版 Chrome（2022 年前）几乎只出现在爬虫/测速工具
const OLD_CHROME_THRESHOLD = 100;

// 内存冷却
const memoryCooldown = new Map();
const MEMORY_MAX = 10000;

function memoryPeek(key, ttlMs) {
  const now  = Date.now();
  const last = memoryCooldown.get(key);
  return !(last && now - last < ttlMs);
}
function memorySet(key) {
  memoryCooldown.set(key, Date.now());
  if (memoryCooldown.size > MEMORY_MAX) {
    const now = Date.now();
    for (const [k, v] of memoryCooldown) {
      if (now - v > 10 * 60 * 1000) memoryCooldown.delete(k);
    }
  }
}

function ipSegment(ip) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const p = ip.split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') : ip;
}

// 爬虫 / 测速工具识别
function isBotRequest(request) {
  const ua       = request.headers.get('User-Agent') || '';
  const referer  = request.headers.get('Referer') || request.headers.get('Origin') || '';
  const pathname = new URL(request.url).pathname;

  // UA 关键字命中
  if (BOT_RE.test(ua)) return { bot: true, reason: 'bot-ua' };

  // Referer 来自已知测速站
  if (REFERER_BLOCK_RE.test(referer)) return { bot: true, reason: 'bot-referer' };

  // 老版 Chrome（< 100）
  const m = ua.match(/Chrome\/(\d+)\./i);
  if (m && parseInt(m[1], 10) < OLD_CHROME_THRESHOLD) {
    return { bot: true, reason: 'old-chrome-' + m[1] };
  }

  // Referer = 图片自己的 URL
  if (referer && referer.includes(pathname)) {
    return { bot: true, reason: 'self-referer' };
  }

  return { bot: false };
}

// 入口
export default {
  async fetch(request, env, ctx) {
    try {
      const { pathname } = new URL(request.url);

      if (pathname.startsWith('/api/')) {
        try {
          return await handleApi(request, env, ctx, pathname.slice(5));
        } catch (e) {
          console.error('[api error]', (e && e.stack) || e);
          return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
        }
      }

      const m = pathname.match(PIC_RE);
      if (m) {
        try {
          return await handleVisit(request, env, ctx, m[1]);
        } catch (e) {
          console.error('[visit error]', (e && e.stack) || e);
          return new Response('Not Found', { status: 404 });
        }
      }

      if (env.ASSETS) {
        try {
          return await env.ASSETS.fetch(request);
        } catch (e) {
          console.error('[assets error]', (e && e.stack) || e);
          return new Response('Not Found', { status: 404 });
        }
      }
      return notFound();

    } catch (e) {
      console.error('[top error]', (e && e.stack) || e);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

// API 路由
async function handleApi(request, env, ctx, sub) {
  const method = request.method;

  if (sub === 'login'  && method === 'POST') return handleLogin(request, env);
  if (!checkAuth(request, env)) return unauthorized();

  if (sub === 'init'   && method === 'GET')  return handleInitCheck(env);
  if (sub === 'init'   && method === 'POST') return handleInitRun(env);
  if (sub === 'data'   && method === 'GET')  return handleData(env);
  if (sub === 'logs'   && method === 'GET')  return handleLogs(request, env);
  if (sub === 'hours'  && method === 'GET')  return handleHourly(request, env);
  if (sub === 'images' && method === 'POST') return handleSaveImages(request, env);
  if (sub === 'deploy' && method === 'POST') return handleDeploy(env);

  return notFound();
}

// 初始化检查
async function handleInitCheck(env) {
  try {
    await env.DB.prepare('SELECT 1 FROM visits LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM daily_summary LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM img_index LIMIT 1').all();
    return jsonResponse({ ok: true, initialized: true });
  } catch (e) {
    return jsonResponse({ ok: true, initialized: false, reason: e.message });
  }
}

// 执行初始化建表
async function handleInitRun(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS visits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier  TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      visit_date  TEXT    NOT NULL,
      ip          TEXT,
      country     TEXT,
      region      TEXT,
      city        TEXT,
      isp         TEXT,
      ua          TEXT,
      device      TEXT,
      os          TEXT,
      browser     TEXT,
      engine      TEXT,
      referer     TEXT,
      is_bot      INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits(visit_date DESC, ts DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_id_date ON visits(identifier, visit_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_ip      ON visits(ip)`,
    `CREATE TABLE IF NOT EXISTS daily_summary (
      date        TEXT    NOT NULL,
      identifier  TEXT    NOT NULL,
      count       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, identifier)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_summary_date ON daily_summary(date DESC)`,
    `CREATE TABLE IF NOT EXISTS img_index (
      identifier  TEXT    PRIMARY KEY,
      name        TEXT,
      file        TEXT    NOT NULL,
      ext         TEXT,
      mime        TEXT,
      size        INTEGER,
      hash        TEXT,
      sort_order  INTEGER DEFAULT 0,
      updated_at  INTEGER
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
    await env.DB.prepare('SELECT 1 FROM visits LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM daily_summary LIMIT 1').all();
    await env.DB.prepare('SELECT 1 FROM img_index LIMIT 1').all();
    return jsonResponse({ ok: true, message: '数据库初始化完成', results });
  } catch (e) {
    return jsonResponse({ ok: false, error: '建表后验证失败: ' + e.message, results }, 500);
  }
}

// 鉴权
function checkAuth(request, env) {
  const auth = request.headers.get('X-Auth-Token') || '';
  return !!auth && !!env.PASSWORD && constantTimeEqual(auth, env.PASSWORD);
}

// 恒定时间比较
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < ab.length; i++) r |= ab[i] ^ bb[i];
  return r === 0;
}

// 登录
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: '格式错误' }, 400); }
  if (!env.PASSWORD) return jsonResponse({ ok: true });
  if (typeof body.password !== 'string' || !constantTimeEqual(body.password, env.PASSWORD)) {
    return jsonResponse({ ok: false, error: '密码错误' }, 401);
  }
  return jsonResponse({ ok: true });
}

// 数据接口
async function handleData(env) {
  const [index, stats] = await Promise.all([readIndex(env), getStats(env)]);
  return jsonResponse({ ok: true, images: index, stats });
}

// 读取图片索引
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

// 统计
async function getStats(env) {
  const now   = new Date();
  const dates = [];
  for (let i = 0; i < STATS_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
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

  const index = await readIndex(env);
  for (const item of index) idSet.add(item.identifier);

  for (const id of idSet) {
    if (!byIdentifier[id]) byIdentifier[id] = {};
    for (const d of dates) {
      if (byIdentifier[id][d] === undefined) byIdentifier[id][d] = 0;
    }
  }

  return {
    dates: dates.slice().reverse(),   // 升序（最旧 → 最新）
    totalByDate,
    byIdentifier,
    identifiers: [...idSet].sort(),
  };
}

// 今日 24 小时统计
async function handleHourly(request, env) {
  const url        = new URL(request.url);
  const identifier = url.searchParams.get('identifier') || '';
  const tzOffset   = 8;   // 上海时区 UTC+8

  const now      = Date.now();
  // 上海今天 0 点对应的 UTC 毫秒
  const localNow = new Date(now + tzOffset * 3600 * 1000);
  const localMidnight = new Date(Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    0, 0, 0, 0
  ) - tzOffset * 3600 * 1000);

  const todayStart = localMidnight.getTime();
  const todayEnd   = todayStart + 24 * 3600 * 1000;

  // 今天非 bot 记录按小时分组
  const conds  = ['ts >= ?', 'ts < ?', 'is_bot = 0'];
  const params = [todayStart, todayEnd];
  if (identifier) {
    conds.push('identifier = ?');
    params.push(identifier);
  }
  const where = 'WHERE ' + conds.join(' AND ');

  try {
    const { results } = await env.DB.prepare(
      `SELECT ts FROM visits ${where} ORDER BY ts ASC`
    ).bind(...params).all();

    // 按小时分桶 0~23
    const buckets = new Array(24).fill(0);
    for (const row of results) {
      // 转成上海时间小时
      const localTs = row.ts + tzOffset * 3600 * 1000;
      const hour    = Math.floor((localTs % (24 * 3600 * 1000)) / (3600 * 1000));
      if (hour >= 0 && hour < 24) buckets[hour]++;
    }

    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');
    return jsonResponse({ ok: true, hours, counts: buckets });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}

// 详细日志
async function handleLogs(request, env) {
  const url        = new URL(request.url);
  const date       = url.searchParams.get('date')       || '';
  const identifier = url.searchParams.get('identifier') || '';
  const ip         = url.searchParams.get('ip')         || '';
  const includeBot = url.searchParams.get('bot') === '1';
  const page       = Math.max(1, parseInt(url.searchParams.get('page')     || '1',  10));
  const pageSize   = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pageSize') || '50', 10)));

  const conds = [], params = [];
  if (date)        { conds.push('visit_date = ?'); params.push(date); }
  if (identifier)  { conds.push('identifier = ?'); params.push(identifier); }
  if (ip)          { conds.push('ip LIKE ?');       params.push('%' + ip + '%'); }
  if (!includeBot)   conds.push('is_bot = 0');
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

// 保存图片
async function handleSaveImages(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: '格式错误' }, 400); }

  const uploads = Array.isArray(body.images) ? body.images : [];
  const keeps   = Array.isArray(body.keep)   ? body.keep   : [];

  if (uploads.length + keeps.length > 200) {
    return jsonResponse({ ok: false, error: '总条目不能超过 200' }, 400);
  }

  const seen = new Set();
  for (const item of uploads) {
    if (typeof item.identifier !== 'string' || !ID_RE.test(item.identifier)) {
      return jsonResponse({ ok: false, error: `非法标识符：${item.identifier || '(空)'}` }, 400);
    }
    if (item.identifier === PANEL_ID) {
      return jsonResponse({ ok: false, error: `"${PANEL_ID}" 是系统保留标识符，请换一个` }, 400);
    }
    if (seen.has(item.identifier)) {
      return jsonResponse({ ok: false, error: `标识符重复：${item.identifier}` }, 400);
    }
    seen.add(item.identifier);
    if (typeof item.base64 !== 'string' || !item.base64) {
      return jsonResponse({ ok: false, error: `${item.identifier} 缺少图片` }, 400);
    }
  }
  for (const item of keeps) {
    if (typeof item.identifier !== 'string' || !ID_RE.test(item.identifier)) {
      return jsonResponse({ ok: false, error: `非法标识符：${item.identifier || '(空)'}` }, 400);
    }
    if (item.identifier === PANEL_ID) {
      return jsonResponse({ ok: false, error: `"${PANEL_ID}" 是系统保留标识符，请换一个` }, 400);
    }
    if (seen.has(item.identifier)) {
      return jsonResponse({ ok: false, error: `标识符重复：${item.identifier}` }, 400);
    }
    seen.add(item.identifier);
  }

  const oldIndex = await readIndex(env);
  const oldMap   = new Map(oldIndex.map(x => [x.identifier, x]));

  const newIndex = [];
  const toDelete = [];
  const toUpload = [];

  // 保留项
  for (const k of keeps) {
    const old = oldMap.get(k.identifier);
    if (!old || !old.file) {
      return jsonResponse({
        ok: false,
        error: `${k.identifier} 在服务器上没有图片，请重新上传`,
      }, 400);
    }
    newIndex.push({
      identifier: k.identifier,
      name: String(k.name || old.name || '').slice(0, 100),
      file: old.file, ext: old.ext, mime: old.mime, size: old.size, hash: old.hash,
    });
  }

  // 上传项
  for (const item of uploads) {
    const { mime, base64Data } = parseBase64Image(item.base64);
    let bytes;
    try { bytes = base64ToBytes(base64Data); }
    catch { return jsonResponse({ ok: false, error: `${item.identifier} base64 损坏` }, 400); }

    if (bytes.length === 0) {
      return jsonResponse({ ok: false, error: `${item.identifier} 图片为空` }, 400);
    }
    if (bytes.length > 8 * 1024 * 1024) {
      return jsonResponse({ ok: false, error: `${item.identifier} 图片过大（>8MB）` }, 400);
    }

    const ext      = mimeToExt(mime);
    const fileName = `${item.identifier}.${ext}`;
    const filePath = `${GIT_DIR}/${fileName}`;
    const hash     = await sha256Short(bytes, 8);

    const old = oldMap.get(item.identifier);
    if (old && old.file && old.file !== fileName) {
      toDelete.push(`${GIT_DIR}/${old.file}`);
    }

    toUpload.push({ path: filePath, bytes, message: `update: ${item.identifier}.${ext}` });
    newIndex.push({
      identifier: item.identifier,
      name: String(item.name || '').slice(0, 100),
      file: fileName, ext, mime, size: bytes.length, hash,
    });
  }

  // 删除不再使用的旧图
  const newIds = new Set(newIndex.map(x => x.identifier));
  for (const old of oldIndex) {
    if (!newIds.has(old.identifier) && old.file) {
      toDelete.push(`${GIT_DIR}/${old.file}`);
    }
  }

  // 上传新图到 Git
  for (const u of toUpload) {
    await gitPutBinary(env, u.path, u.bytes, u.message);
  }

  // 写入 D1 索引
  try {
    await writeIndexToD1(env, newIndex);
  } catch (e) {
    console.error('[D1 writeIndex failed]', e);
    return jsonResponse({ ok: false, error: '保存索引失败：' + e.message }, 500);
  }

  // 清理旧图
  let deleted = 0;
  const deleteErrors = [];
  if (toDelete.length) {
    const results = await Promise.allSettled(
      toDelete.map(p => gitDelete(env, p, 'cleanup: remove obsolete image'))
    );
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') deleted++;
      else deleteErrors.push({ path: toDelete[i], error: r.reason?.message || String(r.reason) });
    });
  }

  return jsonResponse({
    ok: true,
    count: newIndex.length,
    uploaded: toUpload.length,
    deleted,
    deleteErrors: deleteErrors.length ? deleteErrors : undefined,
    index: newIndex,
  });
}

// 写入 D1 索引
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
  newIndex.forEach((item, i) => {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO img_index (identifier, name, file, ext, mime, size, hash, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET
           name       = excluded.name,
           file       = excluded.file,
           ext        = excluded.ext,
           mime       = excluded.mime,
           size       = excluded.size,
           hash       = excluded.hash,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`
      ).bind(
        item.identifier, item.name || '', item.file,
        item.ext || '', item.mime || '', item.size || 0,
        item.hash || '', i, now
      )
    );
  });

  await env.DB.batch(stmts);
}

// 触发部署
async function handleDeploy(env) {
  const hookUrl = env.CF_DEPLOY_HOOK_URL;
  if (!hookUrl) return jsonResponse({ ok: false, error: '未配置 CF_DEPLOY_HOOK_URL' }, 500);
  try {
    const resp = await fetch(hookUrl, { method: 'POST' });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return jsonResponse({ ok: false, error: `Hook ${resp.status} ${t.slice(0, 120)}` }, 502);
    }
    return jsonResponse({ ok: true, message: '部署已触发' });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message || String(e) }, 502);
  }
}

// 面板地址：用请求域名
function getPanelUrl(request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

// 图片访问（核心）
async function handleVisit(request, env, ctx, identifier) {
  if (!ID_RE.test(identifier)) return notFound();

  const ua      = request.headers.get('User-Agent') || '';
  const referer = request.headers.get('Referer') || request.headers.get('Origin') || '';
  const botCheck = isBotRequest(request);

  // 内置追踪点 _panel.svg
  if (identifier === PANEL_ID) {
    if (!botCheck.bot) {
      ctx.waitUntil(
        (async () => {
          try { await trackVisit(request, env, identifier); }
          catch (e) { console.error('[panel track failed]', (e && e.stack) || e); }
        })()
      );
    } else {
      console.log('[panel visit] skipped bot:', botCheck.reason);
    }
    const svgBytes = new TextEncoder().encode(PANEL_SVG);
    return new Response(svgBytes, {
      status: 200,
      headers: {
        'Content-Type':                'image/svg+xml; charset=utf-8',
        'Cache-Control':               'no-store, no-cache, must-revalidate',
        'Content-Length':              String(svgBytes.length),
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 普通图片
  const index = await readIndex(env);
  const item  = index.find(x => x && x.identifier === identifier);
  if (!item || !item.file) return notFound();

  if (!botCheck.bot) {
    ctx.waitUntil(
      (async () => {
        try { await trackVisit(request, env, identifier); }
        catch (e) { console.error('[track failed]', (e && e.stack) || e); }
      })()
    );
  } else {
    console.log('[visit] skipped bot:', botCheck.reason,
      '| ua:', ua.slice(0, 80), '| ref:', referer.slice(0, 80));
  }

  return await serveImage(request, env, item);
}

// 返回图片资源
async function serveImage(request, env, item) {
  if (!env.ASSETS) {
    console.error('[serveImage] env.ASSETS undefined');
    return notFound();
  }

  const candidates = [
    `/pic/${item.file}`,
    `/public/pic/${item.file}`,
  ];

  for (const assetPath of candidates) {
    const assetUrl = new URL(assetPath, request.url);
    let assetResp;
    try {
      assetResp = await env.ASSETS.fetch(new Request(assetUrl.toString(), {
        method: 'GET',
        headers: request.headers,
      }));
    } catch (e) {
      console.error('[serveImage] ASSETS.fetch:', assetPath, e);
      continue;
    }

    if (!assetResp.ok) continue;

    const ct = assetResp.headers.get('Content-Type') || '';
    if (ct.includes('text/html')) continue;

    const headers = new Headers();
    headers.set('Content-Type',                ct || `image/${item.ext || 'png'}`);
    headers.set('Cache-Control',               'public, max-age=300, must-revalidate');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Tracker',                   item.identifier);
    if (item.hash) headers.set('ETag', `"${item.hash}"`);
    const len = assetResp.headers.get('Content-Length');
    if (len) headers.set('Content-Length', len);

    return new Response(assetResp.body, { status: 200, headers });
  }

  return notFound();
}

// 写库追踪
async function trackVisit(request, env, identifier) {
  const ip      = request.headers.get('CF-Connecting-IP') || 'Unknown';
  const ua      = request.headers.get('User-Agent') || '';
  const referer = request.headers.get('Referer')
               || request.headers.get('Origin')
               || request.url;
  const cf      = request.cf || {};
  const { os, browser, engine, device } = parseUA(ua);
  const now  = Date.now();
  const date = formatDate(new Date());

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visits (
           identifier, ts, visit_date, ip, country, region, city, isp, ua,
           device, os, browser, engine, referer, is_bot
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        identifier, now, date, ip,
        cf.country || '', cf.region || '', cf.city || '', cf.asOrganization || '',
        ua.slice(0, 500),
        device, os, browser, engine,
        referer.slice(0, 500),
        0
      ),
      env.DB.prepare(
        `INSERT INTO daily_summary (date, identifier, count)
         VALUES (?, ?, 1)
         ON CONFLICT(date, identifier) DO UPDATE SET count = count + 1`
      ).bind(date, identifier),
    ]);
  } catch (e) {
    console.error('[D1 write failed]', (e && e.message) || e);
  }

  try {
    await maybeNotify(request, env, identifier, {
      ip, ua, cf, referer, os, browser, engine, device,
    });
  } catch (e) {
    console.error('[notify failed]', (e && e.stack) || e);
  }
}

// Telegram 推送
async function maybeNotify(request, env, identifier, info) {
  const ttlMs  = PUSH_COOLDOWN_SEC * 1000;
  const ipKey  = `ip:${info.ip}`;
  const segKey = `seg:${ipSegment(info.ip)}`;

  if (!memoryPeek(ipKey,  ttlMs)) return;
  if (!memoryPeek(segKey, ttlMs)) return;

  memorySet(ipKey);
  memorySet(segKey);

  let idToday = 1, totalToday = 1;
  const today = formatDate(new Date());
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         (SELECT count FROM daily_summary WHERE date = ? AND identifier = ?) AS idToday,
         (SELECT SUM(count) FROM daily_summary WHERE date = ?) AS totalToday`
    ).bind(today, identifier, today).all();
    idToday    = results[0]?.idToday    || 1;
    totalToday = results[0]?.totalToday || 1;
  } catch (e) { console.error('[D1 count]', e); }

  let name = identifier;
  if (identifier === PANEL_ID) {
    name = '🟢 管理面板';
  } else {
    try {
      const index = await readIndex(env);
      const item  = index.find(x => x && x.identifier === identifier);
      if (item?.name) name = item.name;
    } catch (e) {
      // 忽略
    }

  const flag     = countryCodeToEmoji(info.cf.country || '');
  const location = [info.cf.country, info.cf.region, info.cf.city].filter(Boolean).join(' ') || '未知';
  const nowStr   = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

  const mEsc = (s, max = 80) => {
    let x = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    if (x.length > max) x = x.slice(0, max - 1) + '…';
    return x.replace(/([*_`\[\]])/g, '\\$1');
  };

  const L = {
    id:   '标    识',
    ip:   'IP地址',
    geo:  '归属地',
    isp:  '运营商',
    ref:  '来    源',
    dev:  '设    备',
    brw:  '浏览器',
    day:  '今    日',
    time: '时    间',
  };

  const message =
    '🔰 *访客累计：' + totalToday + '*\n\n' +
    '*来源信息*\n' +
    '· ' + L.id  + '：' + mEsc(name, 40)                    + '\n' +
    '· ' + L.ip  + '：`' + mEsc(info.ip, 50)                + '`\n' +
    '· ' + L.geo + '：' + flag + ' ' + mEsc(location, 50)   + '\n' +
    '· ' + L.isp + '：' + mEsc(info.cf.asOrganization || '未知', 40) + '\n' +
    '· ' + L.ref + '：`' + mEsc(info.referer || '—', 60)    + '`\n\n' +
    '*设备指纹*\n' +
    '· ' + L.dev + '：' + mEsc(info.device, 20) + ' · ' + mEsc(info.os, 40)      + '\n' +
    '· ' + L.brw + '：' + mEsc(info.browser, 40) + ' · ' + mEsc(info.engine, 40) + '\n\n' +
    '· ' + L.day  + '：' + idToday + ' 次\n' +
    '· ' + L.time + '：' + nowStr;

  const panelUrl = getPanelUrl(request);

  const payload = {
    chat_id: env.TG_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: '👤 管理仪表盘', url: panelUrl }],
      ],
    },
  };

  await sendTelegram(payload, env.TG_TOKEN);
}

// 发送 TG 消息
async function sendTelegram(payload, token) {
  if (!token)                        return;
  if (!payload || !payload.chat_id)  return;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('TG failed:', res.status, t.slice(0, 200));
    }
  } catch (e) {
    if (e.name === 'AbortError') console.warn('TG timeout');
    else console.error('TG error:', e);
  } finally {
    clearTimeout(timer);
  }
}

// 清理环境变量
function sanitizeEnv(s) {
  return String(s ?? '').trim().replace(/[\r\n\t]+/g, '');
}

// GitHub 配置
function gitConfig(env) {
  const token  = sanitizeEnv(env.GITHUB_TOKEN);
  const repo   = sanitizeEnv(env.REPO_NAME);
  const branch = sanitizeEnv(env.BRANCH) || 'main';
  if (!token) throw new Error('缺少 GITHUB_TOKEN');
  if (!repo)  throw new Error('缺少 REPO_NAME');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))   throw new Error('REPO_NAME 格式错误');
  if (/[^\x20-\x7E]/.test(token))         throw new Error('GITHUB_TOKEN 含非法字符');
  return { token, repo, branch };
}

// GitHub 请求头
function gitHeaders(token) {
  return {
    'Authorization':        `Bearer ${token}`,
    'User-Agent':           'cf-visitor-stat',
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// 上传二进制到 GitHub
async function gitPutBinary(env, path, bytes, message) {
  const cfg     = gitConfig(env);
  const api     = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = gitHeaders(cfg.token);

  let sha;
  const getResp = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  if (getResp.ok) {
    const j = await getResp.json().catch(() => null);
    sha = j?.sha;
  }

  const body = { message, content: bytesToBase64(bytes), branch: cfg.branch };
  if (sha) body.sha = sha;

  const putResp = await fetch(api, {
    method:  'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!putResp.ok) {
    const t = await putResp.text().catch(() => '');
    throw new Error(`GitHub PUT ${path}: ${putResp.status} ${t.slice(0, 120)}`);
  }
  return putResp.json();
}

// 从 GitHub 删除文件
async function gitDelete(env, path, message) {
  const cfg     = gitConfig(env);
  const api     = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
  const headers = gitHeaders(cfg.token);

  const getResp = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  if (getResp.status === 404) return null;
  if (!getResp.ok) {
    const t = await getResp.text().catch(() => '');
    throw new Error(`GitHub GET ${path}: ${getResp.status} ${t.slice(0, 120)}`);
  }
  const j   = await getResp.json();
  const sha = j.sha;

  const delResp = await fetch(api, {
    method:  'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, sha, branch: cfg.branch }),
  });
  if (!delResp.ok) {
    const t = await delResp.text().catch(() => '');
    throw new Error(`GitHub DELETE ${path}: ${delResp.status} ${t.slice(0, 120)}`);
  }
  return true;
}

// 日期（上海时区）YYYY-MM-DD
function formatDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// 解析 dataURL
function parseBase64Image(raw) {
  const m = raw.match(/^data:([^;]*);base64,(.+)$/i);
  return m ? { mime: m[1] || 'image/png', base64Data: m[2] }
           : { mime: 'image/png', base64Data: raw };
}

// base64 -> bytes
function base64ToBytes(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// bytes -> base64
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 短 SHA-256
async function sha256Short(bytes, len = 8) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const arr  = new Uint8Array(hash);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

// mime -> 扩展名
function mimeToExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('svg'))                       return 'svg';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('gif'))                       return 'gif';
  if (m.includes('webp'))                      return 'webp';
  return 'png';
}

// 国家代码 -> emoji 国旗
function countryCodeToEmoji(code) {
  if (!code || code.length !== 2) return '';
  const OFF = 0x1F1E6 - 'A'.charCodeAt(0);
  return [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + OFF)).join('');
}

// 简单 UA 解析
function parseUA(ua) {
  let os = '未知系统', browser = '未知浏览器', engine = '未知内核', device = 'PC';
  if (/Mobile|Android|iPhone|BlackBerry|IEMobile|Silk/.test(ua)) device = '手机';
  else if (/iPad|Tablet/.test(ua)) device = '平板';

  if (/Windows NT 10/.test(ua))      os = 'Windows 10';
  else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/.test(ua)) os = 'Windows 7';
  else if (/Mac OS X/.test(ua))      os = 'macOS';
  else if (/Android/.test(ua))       os = 'Android';
  else if (/iPhone|iPad/.test(ua))   os = 'iOS';
  else if (/Linux/.test(ua))         os = 'Linux';

  const m = (re) => { const r = ua.match(re); return r ? r[1] : null; };
  const qq = m(/QQBrowser\/([\d.]+)/);   if (qq) browser = `QQ浏览器 ${qq}`;
  else { const uc = m(/UCBrowser\/([\d.]+)/); if (uc) browser = `UC浏览器 ${uc}`;
  else { const ed = m(/Edg\/([\d.]+)/);       if (ed) browser = `Edge ${ed}`;
  else { const ch = m(/Chrome\/([\d.]+)/);    if (ch) browser = `Chrome ${ch}`;
  else { const sf = m(/Safari\/([\d.]+)/);    if (sf) browser = `Safari ${sf}`;
  else { const ff = m(/Firefox\/([\d.]+)/);   if (ff) browser = `Firefox ${ff}`;
  else { const ie = m(/MSIE\s([\d.]+)/);      if (ie) browser = `IE ${ie}`; }}}}}}

  const wk = m(/AppleWebKit\/([\d.]+)/);
  if (wk) engine = `AppleWebKit/${wk}`;
  else if (/Gecko\//.test(ua)) engine = 'Gecko';
  else { const tr = m(/Trident\/([\d.]+)/); if (tr) engine = `Trident/${tr}`; }

  return { os, browser, engine, device };
}

// JSON 响应
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function notFound()    { return new Response('Not Found',  { status: 404 }); }
function unauthorized(){ return jsonResponse({ ok: false, error: '未授权' }, 401); }