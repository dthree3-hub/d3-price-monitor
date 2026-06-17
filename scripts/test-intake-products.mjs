import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intakeRowsFromCsv, loadIntakeProducts, INTAKE_CSV_HEADER } from '../src/intake-products.mjs';

const HEADER = INTAKE_CSV_HEADER.join(',');

test('maps active rows to loadProducts-shaped objects', () => {
  const csv = `${HEADER}\n`
    + `Galaxy S26,0,Deal Direct,,Galaxy S26,https://shopee.com.my/x-i.116917349.999.html,12GB 256GB,active,2026-06-17\n`;
  const rows = intakeRowsFromCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].our_product, 'Galaxy S26');
  assert.equal(rows[0].competitor, 'Deal Direct');
  assert.equal(rows[0].product_url, 'https://shopee.com.my/x-i.116917349.999.html');
  assert.equal(rows[0].variant, '12GB 256GB');
});

test('filters out non-active and missing-url rows', () => {
  const csv = `${HEADER}\n`
    + `A,0,M1,,A,https://shopee.com.my/a-i.1.2,, ignore ,d\n`        // status ignore → drop
    + `B,0,M2,,B,,,,d\n`                                              // no product_url → drop
    + `C,0,M3,,C,https://shopee.com.my/c-i.3.4,,active,d\n`;          // keep
  const rows = intakeRowsFromCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].our_product, 'C');
});

test('empty status counts as active (parity with loadProducts)', () => {
  const csv = `${HEADER}\nD,0,M,,D,https://shopee.com.my/d-i.5.6,,,d\n`;
  assert.equal(intakeRowsFromCsv(csv).length, 1);
});

test('loadIntakeProducts returns [] when file missing', () => {
  assert.deepEqual(loadIntakeProducts('/nonexistent/product-intake.csv'), []);
});

test('loadIntakeProducts reads a real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
  const file = path.join(dir, 'product-intake.csv');
  fs.writeFileSync(file, `${HEADER}\nWatch S5,0,TAC,,Watch S5,https://shopee.com.my/w-i.7.8,,active,d\n`);
  const rows = loadIntakeProducts(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].our_product, 'Watch S5');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('headerless csv falls back to canonical header', () => {
  const csv = `Galaxy A56,0,Spray,,Galaxy A56,https://shopee.com.my/a-i.9.10,8GB 256GB,active,d\n`;
  const rows = intakeRowsFromCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_url, 'https://shopee.com.my/a-i.9.10');
});
