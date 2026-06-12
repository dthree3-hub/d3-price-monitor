const WORKER_URL = process.env.D3_WORKER_URL || '';

export default async function handler(req, res) {
  if (!WORKER_URL) return res.status(500).json({ error: 'D3_WORKER_URL not set' });

  res.setHeader('Cache-Control', 's-maxage=0, no-cache');

  if (req.method === 'GET') {
    const r = await fetch(`${WORKER_URL}/api/records`);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream error' });
    const data = await r.json();
    return res.json(data); // { records: [...] }
  }

  res.status(405).json({ error: 'method not allowed' });
}
