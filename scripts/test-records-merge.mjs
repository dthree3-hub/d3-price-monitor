import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the records store at a throwaway temp file BEFORE lib-records is ever imported,
// so these tests never read/write the real data/records.json.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const recFile = path.join(tmpDir, 'records.json');
process.env.D3_RECORDS_FILE = recFile;

const { mergeRecords, readRecords, writeRecords } = await import('../src/lib-records.mjs');
const { mergeNewRecords, pruneRecordsToWatchlist } = await import('../src/lib-hermes.mjs');

// shopId:itemId:grabbedAt is the record key. Minimal valid record needs a variants array.
const rec = (shopId, itemId, extra = {}) => ({
  shopId: String(shopId), itemId: String(itemId), grabbedAt: '2026-06-17T00:00:00.000Z',
  pageUrl: `https://shopee.com.my/x-i.${shopId}.${itemId}`, variants: [], title: `p-${itemId}`, ...extra,
});
const seed = (records) => writeRecords(records);
const keysOf = (records) => new Set(records.map((r) => `${r.shopId}:${r.itemId}`));

// ── pure mergeRecords (the upsert core the fix relies on) ─────────────────────

test('mergeRecords keeps all existing and appends new keys', () => {
  const existing = Array.from({ length: 71 }, (_, i) => rec(100, 1000 + i));
  const incoming = [rec(900, 9999)]; // brand-new key
  const merged = mergeRecords(existing, incoming);
  assert.equal(merged.length, 72, '71 old + 1 new = 72');
  const k = keysOf(merged);
  for (let i = 0; i < 71; i += 1) assert.ok(k.has(`100:${1000 + i}`), `old key 100:${1000 + i} kept`);
  assert.ok(k.has('900:9999'), 'new key added');
});

test('mergeRecords overwrites on duplicate key (same shopId:itemId:grabbedAt)', () => {
  const existing = [rec(100, 1, { title: 'old' })];
  const incoming = [rec(100, 1, { title: 'new' })]; // same key → update
  const merged = mergeRecords(existing, incoming);
  assert.equal(merged.length, 1, 'duplicate key does not grow the list');
  assert.equal(merged[0].title, 'new', 'incoming overwrites existing');
});

// ── mergeNewRecords (sweep path): must NOT prune old records anymore ──────────

test('mergeNewRecords keeps 71 old records when products list has only 1 intake', () => {
  seed(Array.from({ length: 71 }, (_, i) => rec(100, 2000 + i)));
  const intakeRecord = rec(888, 999); // the freshly scraped intake product
  const intakeProductOnly = [{ product_url: 'https://shopee.com.my/test-i.888.999' }]; // shrunken watchlist
  const { merged } = mergeNewRecords([intakeRecord], intakeProductOnly);
  assert.equal(merged.length, 72, '71 old survive + 1 intake = 72 (no prune)');
  const onDisk = readRecords();
  assert.equal(onDisk.length, 72, 'records.json on disk has 72 (old not deleted)');
  assert.ok(keysOf(onDisk).has('888:999'), 'intake record written');
  for (let i = 0; i < 71; i += 1) assert.ok(keysOf(onDisk).has(`100:${2000 + i}`), 'old kept');
});

test('mergeNewRecords with EMPTY products list still keeps all old records', () => {
  seed(Array.from({ length: 71 }, (_, i) => rec(100, 3000 + i)));
  const { merged } = mergeNewRecords([rec(888, 1)], []); // base=0 scenario
  assert.equal(merged.length, 72, 'empty watchlist must not wipe history');
  assert.equal(readRecords().length, 72);
});

test('mergeNewRecords updates an existing record in place (dup key)', () => {
  seed([rec(100, 5, { title: 'before' })]);
  const { merged } = mergeNewRecords([rec(100, 5, { title: 'after' })], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'after');
});

// ── explicit prune still works when called on purpose (NOT in sweep) ─────────

test('pruneRecordsToWatchlist removes records not in the watchlist (explicit only)', () => {
  seed([rec(100, 1), rec(100, 2), rec(888, 999)]);
  const watchlist = [{ product_url: 'https://shopee.com.my/test-i.888.999' }]; // only 888:999
  const { kept, removed } = pruneRecordsToWatchlist(watchlist);
  assert.equal(removed, 2, 'two off-watchlist records removed');
  assert.equal(kept.length, 1);
  assert.equal(readRecords()[0].itemId, '999');
});

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
