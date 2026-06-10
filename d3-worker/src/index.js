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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── GET /api/records ─────────────────────────────────────────────────────
    // Returns {records:[...]} compatible with existing frontend
    if (pathname === '/api/records' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT shop_id, item_id, title, sku, model, capacity, tier, price, voucher_amount, sold_out, grabbed_at
        FROM variant_prices
        ORDER BY shop_id, item_id, model, tier
      `).all();
      return json({ records: rowsToRecords(results) });
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

      const stmts = [];
      for (const rec of records) {
        if (!Array.isArray(rec.variants)) continue;
        for (const v of rec.variants) {
          if (!v.model) continue;
          const sku = v.model + (v.capacity ? ` ${v.capacity}` : '');
          stmts.push(
            env.DB.prepare(`
              INSERT INTO variant_prices
                (shop_id, item_id, title, sku, model, capacity, tier, price, voucher_amount, sold_out, grabbed_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(shop_id, item_id, model, tier) DO UPDATE SET
                title=excluded.title, sku=excluded.sku,
                capacity=excluded.capacity, price=excluded.price,
                voucher_amount=excluded.voucher_amount,
                sold_out=excluded.sold_out,
                grabbed_at=excluded.grabbed_at, updated_at=datetime('now')
            `).bind(
              rec.shopId, rec.itemId, rec.title || '', sku,
              v.model, v.capacity || '', v.tier || '', v.currentPrice ?? null,
              v.voucherAmount ?? rec.voucherAmount ?? 0,
              (v.inStock === false || rec.soldOut) ? 1 : 0,
              rec.grabbedAt || new Date().toISOString()
            )
          );
          // Insert history only when price actually changes
          if (v.currentPrice != null) {
            stmts.push(
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
      }

      // D1 batch limit = 100 statements
      for (let i = 0; i < stmts.length; i += 100) {
        await env.DB.batch(stmts.slice(i, i + 100));
      }

      return json({ ok: true, records: records.length, stmts: stmts.length });
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
