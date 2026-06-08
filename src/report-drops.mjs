import fs from 'node:fs';
import path from 'node:path';
import { buildDropReport, readRecords, reportFile } from './lib-records.mjs';

function formatRm(value) {
  return value == null ? 'N/A' : `RM${value}`;
}

function buildMarkdown(drops, latestTimestamp) {
  const lines = [
    '# D3 Daily Drop Report',
    '',
    `- 生成时间: ${new Date().toISOString()}`,
    `- 最新抓取批次: ${latestTimestamp || '无数据'}`,
    `- 降价款式数: ${drops.length}`,
    '',
  ];

  if (!drops.length) {
    lines.push('今天没有检测到降价。');
    return `${lines.join('\n')}\n`;
  }

  for (const drop of drops) {
    lines.push(`## ${drop.title}`);
    lines.push(`- 款式: ${drop.variantName}`);
    lines.push(`- 店铺: ${drop.sellerName || drop.shopId}`);
    lines.push(`- 价格: ${formatRm(drop.previousPrice)} -> ${formatRm(drop.currentPrice)} (降 ${formatRm(drop.dropAmount)})`);
    lines.push(`- 对比: ${drop.previousGrabbedAt} -> ${drop.grabbedAt}`);
    lines.push(`- 链接: ${drop.pageUrl}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const records = readRecords();
  const latestTimestamp = records[0]?.grabbedAt || null;
  const latestBatch = latestTimestamp
    ? records.filter((record) => record.grabbedAt === latestTimestamp)
    : [];
  const latestKeys = new Set(
    latestBatch.flatMap((record) =>
      record.variants.map((variant) => `${record.shopId}:${record.itemId}:${variant.name}`)
    )
  );

  const drops = buildDropReport(records).filter((drop) =>
    latestKeys.size ? latestKeys.has(`${drop.shopId}:${drop.itemId}:${drop.variantName}`) : true
  );

  const markdown = buildMarkdown(drops, latestTimestamp);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, markdown);

  console.log(markdown.trimEnd());
}

main();
