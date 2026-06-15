const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-D3-Secret',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

// Reconstruct {records:[...]} from D1 rows for frontend compatibility
function rowsToRecords(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.shop_id}:${r.item_id}`;
    if (!map.has(key)) {
      map.set(key, {
        shopId: r.shop_id,
        itemId: r.item_id,
        title: r.title,
        grabbedAt: r.grabbed_at,
        soldOut: false, // 下面按逐款重算
        variants: [],
      });
    }
    const soldOut = !!r.sold_out; // sold_out 列现为逐款标记
    map.get(key).variants.push({
      model: r.model,
      capacity: r.capacity,
      tier: r.tier,
      currentPrice: r.price,
      name: r.sku,
      color: r.color || '',
      variantName: r.variant_name || '',
      voucherAmount: r.voucher_amount ?? 0,
      soldOut,
      inStock: !soldOut,
    });
  }
  // 整个 listing 售罄 = 所有款式都售罄（兼容旧的「记录级 soldOut」语义）
  for (const rec of map.values()) {
    rec.soldOut = rec.variants.length > 0 && rec.variants.every((v) => v.soldOut);
  }
  return Array.from(map.values());
}

// ── Google Sheets 只读：服务账号 JWT(WebCrypto，Worker 非 Node) → Take back (S) ──
const b64urlBuf = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemToPkcs8(pem) {
  const body = String(pem).replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getGoogleToken(saJson) {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${b64urlBuf(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`google token ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token');
  return j.access_token;
}

// A 列 "A06 6+128 5G (A066)" → "A06 5G 128GB"；手表/Buds/Fit 见下方专门分支；其它(配件/标题) → null。
// 前端再过 normalizeModelKey + toLowerCase 与 dashboard mk 匹配(大小写不敏感)。
function parseSkuKey(a) {
  let s = String(a || '').trim();
  if (!s) return null;

  // ── 手表 / Buds / Fit（无 RAM+存储；按 代号去除→尺寸/连接/Classic/年份 拼 key 对齐 dashboard）──
  // 颜色不同 take back 不同时靠调用方 first-wins(取表上第一个)；GIFT/颜色尾巴落到同 key 被去重。
  if (/^\s*(WATCH|BUDS|FIT)\b/i.test(s)) {
    const x = s
      .replace(/\([^)]*\)/g, ' ')                                                     // 去 (L320)/(R410) 代号
      .replace(/\s*[-,]\s*(black|white|gray|grey|blue|silver|graphite|titanium|pink).*$/i, ' ') // 去颜色尾巴
      .replace(/\s+gift\b.*$/i, ' ')                                                  // 去 GIFT/GIFT SET 尾巴
      .replace(/\s+/g, ' ').trim();
    if (/^WATCH/i.test(x)) {
      if (/\bultra\b/i.test(x)) {                       // Watch Ultra [年份]
        const year = (x.match(/\b(20\d\d)\b/) || [])[1] || '';
        return `Watch Ultra${year ? ' ' + year : ''}`;
      }
      const num = (x.match(/watch\s*(\d+)/i) || [])[1];  // Watch 8 [Classic] [44mm] [BT|LTE]
      if (!num) return null;
      const classic = /\bclassic\b/i.test(x) ? ' Classic' : '';
      const size = (x.match(/(\d{2})\s*mm/i) || [])[1];
      const conn = /\bLTE\b/i.test(x) ? 'LTE' : (/\bBT\b/i.test(x) ? 'BT' : '');
      return `Watch ${num}${classic}${size ? ` ${size}mm` : ''}${conn ? ` ${conn}` : ''}`;
    }
    return x || null;                                    // Buds 4 Pro / Buds Core / Fit 3：去代号后即 key
  }

  // ── 平板 S10/S11（与手机不同：无 RAM+存储；可能带 "with KB"/键盘；无存储则默认 128GB）──
  // 仅产出 "S10 FE 256GB" 这种 model[ net] storage；前端 normalizeModelKey 会补 "Tab " 前缀、去 WiFi。
  // 手机是 S25/S26(^S2)，平板是 S10/S11(^S1[01])，互不影响。
  if (/^S1[01]\b/i.test(s)) {
    let x = s
      .replace(/\([^)]*\)/g, ' ')         // 去 (X520)/(xKB)/( X keyboard)
      .replace(/\bwith\s+KB\b/ig, ' ')     // 去 with KB
      .replace(/-\s*[A-Za-z].*$/, ' ')     // 去 "- Gry"/"- Black" 颜色尾巴
      .replace(/\bWi[\s-]?Fi\b/ig, ' ');   // WiFi 默认(前端也会去)
    const tnet = /\b5G\b/i.test(x) ? '5G' : (/\b(4G|LTE)\b/i.test(x) ? '4G' : '');
    const tst = x.match(/(\d+)\s*(TB|GB)\b/i);          // 显式存储 256GB/1TB
    const tstorage = tst ? `${tst[1]}${tst[2].toUpperCase()}` : '128GB'; // 无存储(S10 Lite WiFi)→默认 128GB
    const tmodel = x
      .replace(/\b(5G|4G|LTE)\b/ig, ' ')
      .replace(/\d+\s*(TB|GB)\b/ig, ' ')
      .replace(/\bKB\b/ig, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!tmodel) return null;
    return `${tmodel}${tnet ? ' ' + tnet : ''} ${tstorage}`;
  }

  s = s.replace(/\([^)]*\)/g, ' ');                  // 去 (A066)/(S938) 代码
  const cap = s.match(/(\d+)\+(\d+)\s*(TB|GB)?/i);    // RAM+存储，核心 + 两侧无空格(避开 "S25+ 12")
  if (!cap) return null;
  const storage = `${cap[2]}${(cap[3] || 'GB').toUpperCase()}`;
  const net = /\b5G\b/i.test(s) ? '5G' : (/\b(4G|LTE)\b/i.test(s) ? '4G' : (/\bwifi\b/i.test(s) ? 'WiFi' : ''));
  const model = s.slice(0, cap.index)
    .replace(/\b(5G|4G|LTE|wifi)\b/ig, ' ')
    .replace(/\bwith\s+KB\b/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!model) return null;
  return `${model}${net ? ' ' + net : ''} ${storage}`;
}

function toTakeBack(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 通用数值解析：百分比 "10.26%"→0.1026、货币 "RM34.69"→34.69、空→null
function toNum(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const pct = s.includes('%');
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

// 读 Sheet「Samsung」tab：A 列型号、H 列 Take back (S)。返回 { [parsedKey]: take_back }。
async function fetchTakeBackRows(env) {
  if (!env.GOOGLE_SHEET_ID) throw new Error('missing GOOGLE_SHEET_ID');
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const tab = env.GOOGLE_CSP_TAB || 'Samsung';
  const range = env.GOOGLE_CSP_RANGE || `${tab}!A2:H300`;
  const token = await getGoogleToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sheets ${res.status}`);
  const vals = (await res.json()).values || [];
  const rows = {};
  for (const row of vals) {
    const key = parseSkuKey(row[0]);   // A 列
    const tb = toTakeBack(row[7]);      // H 列 Take back (S)
    if (!key || tb == null) continue;
    if (key in rows) continue;          // first-wins：表上方为准
    // rows[key] 由 number 改为 object（保留 H + 新增 B/C/E/G 供 structured breakdown）。
    // 旧消费端（dashboard / Telegram）期望 number → 由消费端做 number|object 兼容（见 price-lookup takeBackOf）。
    rows[key] = {
      takeBack: tb,                     // H 列 Take back (S)
      csp: toNum(row[1]),               // B 列 CSP
      commissionRate: toNum(row[2]),    // C 列 Shopee Commission (S)，比例(0.1026)
      ccb: toNum(row[4]),               // E 列 CCB 金额
      ads: toNum(row[6]),               // G 列 Ads Credit 金额
    };
  }
  return rows;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── GET /api/records ─────────────────────────────────────────────────────
    // Returns {records:[...]} compatible with existing frontend
    if (pathname === '/api/records' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT shop_id, item_id, title, sku, model, capacity, tier, price, voucher_amount, sold_out, color, variant_name, grabbed_at
        FROM variant_prices
        ORDER BY shop_id, item_id, model, tier, capacity
      `).all();
      return json({ records: rowsToRecords(results) });
    }

    // ── GET /api/csp ───────────────────────────────────────────────────────────
    // 只读 Google Sheet「Samsung」tab 的 Take back (S)(H列)，A列型号解析成 dashboard key。
    // 缓存 45s 防刷 Google；失败返回 {ok:false,error,rows:{}}(前端保留上次成功值)。
    if (pathname === '/api/csp' && request.method === 'GET') {
      const cache = caches.default;
      const cacheKey = new Request(new URL('/api/csp', request.url).toString());
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      try {
        const rows = await fetchTakeBackRows(env);
        const res = json({ ok: true, updatedAt: new Date().toISOString(), count: Object.keys(rows).length, rows });
        res.headers.set('Cache-Control', 'public, max-age=45');
        await cache.put(cacheKey, res.clone());
        return res;
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e), rows: {} });
      }
    }

    // ── Manual refresh trigger ────────────────────────────────────────────────
    // 网页按钮 POST 设标记；Hermes 休息时 GET?consume=1 轮询，看到就立刻抓一圈。
    if (pathname === '/api/trigger') {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS control (k TEXT PRIMARY KEY, v TEXT)`).run();
      if (request.method === 'POST') {
        await env.DB.prepare(`INSERT INTO control (k, v) VALUES ('trigger','1')
          ON CONFLICT(k) DO UPDATE SET v='1'`).run();
        return json({ ok: true, triggered: true });
      }
      if (request.method === 'GET') {
        const consume = new URL(request.url).searchParams.get('consume') === '1';
        const row = await env.DB.prepare(`SELECT v FROM control WHERE k='trigger'`).first();
        const pending = row?.v === '1';
        if (pending && consume) {
          await env.DB.prepare(`UPDATE control SET v='0' WHERE k='trigger'`).run();
        }
        return json({ pending });
      }
    }

    // ── POST /api/sync ────────────────────────────────────────────────────────
    // Hermes writes full records array; upsert to D1
    if (pathname === '/api/sync' && request.method === 'POST') {
      const secret = request.headers.get('X-D3-Secret');
      if (!env.D3_SYNC_SECRET || secret !== env.D3_SYNC_SECRET) {
        return json({ error: 'Unauthorized' }, 401);
      }

      const body = await request.json().catch(() => null);
      const records = Array.isArray(body?.records) ? body.records : [];
      if (!records.length) return json({ ok: true, upserted: 0 });

      // ── P2C 永久修复：每 item「先清后插」替换语义，杜绝 6-key 孤儿 ──
      // variant_prices 是当前快照表：一条 listing 的行 = 它最近一次成功抓取。
      // 对每个「带 ≥1 有效变体」的 item：DELETE 该 item 全部旧行 + INSERT 新行，放进同一个
      // env.DB.batch()（D1 batch 是事务）→ 原子替换，旧 model/孤儿行被清掉。
      // payload 里没有效变体的 item（如失败/空抓取）→ 不 DELETE，旧数据原样保留。
      // price_history 是独立的追加表，单独批量写，不参与替换、永不删。
      const historyStmts = [];
      let itemsReplaced = 0;
      let rowsInserted = 0;

      for (const rec of records) {
        if (!Array.isArray(rec.variants)) continue;

        const itemRows = [];
        for (const v of rec.variants) {
          if (!v.model) continue;
          const sku = v.model + (v.capacity ? ` ${v.capacity}` : '');
          itemRows.push(
            env.DB.prepare(`
              INSERT INTO variant_prices
                (shop_id, item_id, title, sku, model, capacity, tier, price, voucher_amount, sold_out, color, variant_name, grabbed_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(shop_id, item_id, model, tier, capacity, color) DO UPDATE SET
                title=excluded.title, sku=excluded.sku,
                price=excluded.price,
                voucher_amount=excluded.voucher_amount,
                sold_out=excluded.sold_out,
                color=excluded.color, variant_name=excluded.variant_name,
                grabbed_at=excluded.grabbed_at, updated_at=datetime('now')
            `).bind(
              rec.shopId, rec.itemId, rec.title || '', sku,
              v.model, v.capacity || '', v.tier || '', v.currentPrice ?? null,
              v.voucherAmount ?? rec.voucherAmount ?? 0,
              (v.inStock === false || rec.soldOut) ? 1 : 0,
              v.color || '', v.variantName || v.name || '',
              rec.grabbedAt || new Date().toISOString()
            )
          );
          // Insert history only when price actually changes（append-only，永不删）
          if (v.currentPrice != null) {
            historyStmts.push(
              env.DB.prepare(`
                INSERT INTO price_history (shop_id, item_id, sku, model, tier, price, grabbed_at)
                SELECT ?,?,?,?,?,?,?
                WHERE NOT EXISTS (
                  SELECT 1 FROM price_history
                  WHERE shop_id=? AND item_id=? AND model=? AND tier=? AND price=?
                    AND grabbed_at > datetime('now','-1 hour')
                )
              `).bind(
                rec.shopId, rec.itemId, sku, v.model, v.tier || '', v.currentPrice,
                rec.grabbedAt || new Date().toISOString(),
                rec.shopId, rec.itemId, v.model, v.tier || '', v.currentPrice
              )
            );
          }
        }

        // Guard：没有有效变体 → 绝不 DELETE（避免失败/空抓取清空已有数据）
        if (!itemRows.length) continue;

        // 原子替换：DELETE 本 item 全部旧行 + INSERT 新行，同一个 batch（事务）。
        // 单 item 变体数实测 ≤64，+1 条 DELETE 远低于 D1 的 100 条/批上限。
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM variant_prices WHERE shop_id = ? AND item_id = ?`)
            .bind(rec.shopId, rec.itemId),
          ...itemRows,
        ]);
        itemsReplaced += 1;
        rowsInserted += itemRows.length;
      }

      // price_history 追加，与替换解耦，单独批量（D1 100 条/批）
      for (let i = 0; i < historyStmts.length; i += 100) {
        await env.DB.batch(historyStmts.slice(i, i + 100));
      }

      return json({ ok: true, records: records.length, itemsReplaced, rowsInserted, historyRows: historyStmts.length });
    }

    // ── GET /api/history?model=S25+Ultra+256GB ────────────────────────────────
    if (pathname === '/api/history' && request.method === 'GET') {
      const model = new URL(request.url).searchParams.get('model') || '';
      const { results } = await env.DB.prepare(`
        SELECT shop_id, model, tier, price, grabbed_at
        FROM price_history
        WHERE model = ?
        ORDER BY grabbed_at DESC
        LIMIT 500
      `).bind(model).all();
      return json({ history: results });
    }

    return json({ error: 'not found' }, 404);
  },
};
