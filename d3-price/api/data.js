const BIN_ID = '6a277a33f5f4af5e29cf0375';
const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

export default async function handler(req, res) {
  const key = process.env.JSONBIN_KEY;
  if (!key) return res.status(500).json({ error: 'JSONBIN_KEY not set' });

  res.setHeader('Cache-Control', 's-maxage=0, no-cache');

  if (req.method === 'GET') {
    const r = await fetch(`${BIN_URL}/latest`, { headers: { 'X-Master-Key': key } });
    if (!r.ok) return res.status(r.status).json({ error: 'upstream error' });
    const data = await r.json();
    return res.json(data.record); // unwrap envelope → { records: [...] }
  }

  if (req.method === 'POST') {
    // Append single record (bookmarklet upload)
    const newRec = req.body;
    const getResp = await fetch(`${BIN_URL}/latest`, { headers: { 'X-Master-Key': key } });
    const current = getResp.ok ? await getResp.json() : { record: { records: [] } };
    const records = Array.isArray(current.record?.records) ? current.record.records : [];
    records.push(newRec);
    const trimmed = records.slice(-120);
    await fetch(BIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': key },
      body: JSON.stringify({ records: trimmed }),
    });
    return res.json({ ok: true, total: trimmed.length });
  }

  if (req.method === 'PUT') {
    // Replace all records (mergeIncoming full sync)
    const body = req.body;
    const records = Array.isArray(body?.records) ? body.records.slice(-120) : [];
    const r = await fetch(BIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': key },
      body: JSON.stringify({ records }),
    });
    if (!r.ok) return res.status(r.status).json({ error: 'upstream write error' });
    return res.json({ ok: true, total: records.length });
  }

  res.status(405).json({ error: 'method not allowed' });
}
