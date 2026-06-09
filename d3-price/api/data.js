const BIN_ID = '6a277a33f5f4af5e29cf0375';
const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

async function readBin(key) {
  const r = await fetch(`${BIN_URL}/latest`, { headers: { 'X-Master-Key': key } });
  if (!r.ok) throw new Error(`JSONBin read failed: HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data.record?.records) ? data.record.records : [];
}

async function writeBin(key, records) {
  const trimmed = records.slice(-120);
  const r = await fetch(BIN_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': key },
    body: JSON.stringify({ records: trimmed }),
  });
  if (!r.ok) throw new Error(`JSONBin write failed: HTTP ${r.status}`);
  return trimmed.length;
}

export default async function handler(req, res) {
  const key = process.env.JSONBIN_KEY;
  if (!key) return res.status(500).json({ error: 'JSONBIN_KEY not set' });

  res.setHeader('Cache-Control', 's-maxage=0, no-cache');

  if (req.method === 'GET') {
    const records = await readBin(key);
    return res.json({ records });
  }

  // POST: full replace if body has records array (Hermes/runOnce), else append single record (bookmarklet)
  if (req.method === 'POST') {
    const body = req.body;
    if (Array.isArray(body?.records)) {
      // Full replace (runOnce.mjs sends full records array)
      const total = await writeBin(key, body.records);
      return res.json({ ok: true, total });
    }
    // Single record append (bookmarklet upload)
    const existing = await readBin(key);
    existing.push(body);
    const total = await writeBin(key, existing);
    return res.json({ ok: true, total });
  }

  // PUT: full replace (sync-cloud-retry.mjs)
  if (req.method === 'PUT') {
    const body = req.body;
    const records = Array.isArray(body?.records) ? body.records : [];
    const total = await writeBin(key, records);
    return res.json({ ok: true, total });
  }

  res.status(405).json({ error: 'method not allowed' });
}
