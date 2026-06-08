import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const indexPath = path.join(root, 'dashboard', 'index.html');
const appPath = path.join(root, 'dashboard', 'app.js');
const dataPath = path.join(root, 'data', 'records.json');

function defaultOutPath() {
  if (process.env.D3_DASHBOARD_HTML) return process.env.D3_DASHBOARD_HTML;
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Desktop', 'D3-dashboard.html');
  }
  return path.join(root, 'out', 'D3-dashboard.html');
}

export function buildSnapshot(outPath = defaultOutPath()) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const appJs = fs.readFileSync(appPath, 'utf8');
  const records = fs.readFileSync(dataPath, 'utf8');

  const embedded = html.replace(
    '<script src="./app.js"></script>',
    `<script>window.D3_EMBEDDED_RECORDS = ${records};</script>\n    <script>${appJs}</script>`
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, embedded);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = buildSnapshot();
  console.log(`Wrote ${outPath}`);
}
