import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs';

chromium.use(stealth());

const STATE_FILE = 'out/shopee-state.json';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    locale: 'en-MY',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  console.log('浏览器已打开。请在 Shopee 页面里手动登录。');
  console.log('登录完成后，回到终端按 Enter 保存会话。');

  await page.goto('https://shopee.com.my/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  fs.mkdirSync('out', { recursive: true });
  await ctx.storageState({ path: STATE_FILE });
  console.log(`已保存登录会话到 ${STATE_FILE}`);

  await browser.close();
}

main().catch((error) => {
  console.error(`保存 Shopee 登录会话失败: ${error.message || String(error)}`);
  process.exit(1);
});
