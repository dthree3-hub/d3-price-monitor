// google-sheets.mjs — 零依赖读【私有】Google Sheet(服务账号 JWT)。
// 用 Node 自带 crypto 签 RS256 JWT → 换 access token → 调 Sheets API。
// 不装 googleapis,省得在 D3-runtime 再 npm install。
//
// 需要两个环境变量(放 .env):
//   GOOGLE_SHEET_ID                你的表格 ID
//   GOOGLE_SERVICE_ACCOUNT_JSON    服务账号 JSON —— 可以是【文件路径】或【JSON 内容本身】

import crypto from 'node:crypto';
import fs from 'node:fs';

function loadServiceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT_JSON(填 JSON 文件路径或 JSON 内容)');
  // 以 { 开头 = 直接是 JSON 内容;否则当作文件路径读
  const text = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  const sa = JSON.parse(text);
  if (!sa.client_email || !sa.private_key) {
    throw new Error('服务账号 JSON 缺 client_email / private_key');
  }
  return sa;
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 用服务账号私钥签 JWT,向 Google 换一个只读 access token(有效 1 小时)。
async function getAccessToken(scope = 'https://www.googleapis.com/auth/spreadsheets.readonly') {
  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const signature = base64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Google 没返回 access_token');
  return json.access_token;
}

// 读一个区间(如 'Samsung!A:B'),返回二维数组(rows × cols)。
export async function readSheetRange(range, { spreadsheetId = process.env.GOOGLE_SHEET_ID } = {}) {
  if (!spreadsheetId) throw new Error('缺少 GOOGLE_SHEET_ID');
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.values || [];
}
