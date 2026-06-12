import fs from 'node:fs';
import path from 'node:path';
import { ensureDataFile, mergeRecords, readRecords, writeRecords } from './lib-records.mjs';

function usage() {
  console.log('用法: node src/import-records.mjs <json文件或目录> [更多文件...]');
}

function collectJsonFiles(targets) {
  const files = [];

  for (const target of targets) {
    const full = path.resolve(target);
    if (!fs.existsSync(full)) throw new Error(`不存在: ${target}`);

    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) {
        if (name.toLowerCase().endsWith('.json')) files.push(path.join(full, name));
      }
      continue;
    }

    files.push(full);
  }

  return files;
}

function readIncoming(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    usage();
    process.exit(1);
  }

  ensureDataFile();
  const files = collectJsonFiles(targets);
  if (!files.length) throw new Error('没找到任何 json 文件');

  const incoming = [];
  for (const file of files) {
    const rows = readIncoming(file);
    incoming.push(...rows);
  }

  const before = readRecords();
  const merged = mergeRecords(before, incoming);
  writeRecords(merged);

  console.log(`已导入 ${files.length} 个文件`);
  console.log(`原记录数: ${before.length}`);
  console.log(`现记录数: ${merged.length}`);
  console.log(`新增记录数: ${merged.length - before.length}`);
}

main();
