import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  intakeRowsFromCsv, loadIntakeProducts, INTAKE_CSV_HEADER, PRODUCT_INTAKE_CSV_HEADER,
  mergeProducts, loadSweepProducts,
} from '../src/intake-products.mjs';

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

// ── Product Intake merchant-management IIFE (d3-price/index.html) ─────────────
// Runs the real browser IIFE under a minimal DOM/localStorage stub so the merchant
// CRUD (add / delete / rename / default-protection / used-by-product guard) is
// covered without a browser. Emulates <select>.value reset semantics so a delete
// of the selected merchant is verifiably reflected in the dropdown.

const SELECT_IDS = new Set(['pi-merchant', 'pi-category', 'pi-status']);

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, onclick: null, parent: null, files: null,
    textContent: '', className: '', hidden: false, type: '', href: '', download: '',
    _value: '', _innerHTML: '', selectedIndex: -1,
    appendChild(c) {
      this.children.push(c); c.parent = this;
      if (this.tag === 'select' && c.tag === 'option' && this.selectedIndex < 0) this.selectedIndex = 0;
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove() { if (this.parent) this.parent.removeChild(this); },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute() {},
    dispatch(ev, extra) { (this.listeners[ev] || []).forEach((f) => f(Object.assign({ target: this }, extra))); },
    click() {
      if (typeof this.onclick === 'function') this.onclick({ target: this });
      this.dispatch('click');
    },
    get value() {
      if (this.tag !== 'select') return this._value;
      const opts = this.children.filter((c) => c.tag === 'option');
      if (!opts.length) return '';
      const i = this.selectedIndex >= 0 ? this.selectedIndex : 0;
      return opts[i] ? opts[i]._value : '';
    },
    set value(v) {
      if (this.tag !== 'select') { this._value = v; return; }
      const opts = this.children.filter((c) => c.tag === 'option');
      const idx = opts.findIndex((o) => o._value === v);
      this.selectedIndex = idx >= 0 ? idx : (opts.length ? 0 : -1); // browser: non-match resets to first
    },
    get innerHTML() { return this._innerHTML; },
    // We don't parse HTML strings into nodes; just track the string. For non-empty
    // assignments leave one placeholder child so code reading `.lastChild` (renderList's
    // `<td>` cell) still works. Code that needs real child nodes uses appendChild.
    set innerHTML(v) {
      this._innerHTML = v; this.children = []; this.selectedIndex = -1;
      if (v !== '') { const ph = makeEl('span'); ph.parent = this; this.children.push(ph); }
    },
    get lastChild() { return this.children[this.children.length - 1]; },
  };
  return el;
}

function makeEnv() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const byId = {};
  const document = {
    getElementById(id) { return byId[id] || (byId[id] = makeEl(SELECT_IDS.has(id) ? 'select' : 'div')); },
    createElement(tag) { return makeEl(tag); },
    body: makeEl('body'),
    readyState: 'complete',
    addEventListener() {},
  };
  // Elements that carry the `hidden` attribute in index.html (toggled by the IIFE).
  ['pi-merchant-manage', 'pi-overlay', 'pi-review-banner', 'pi-cancel'].forEach((id) => {
    byId[id] = makeEl(SELECT_IDS.has(id) ? 'select' : 'div'); byId[id].hidden = true;
  });
  // <select> options that exist in the HTML markup (the IIFE never builds these).
  [['pi-status', ['Active', 'Testing', 'Ignore']], ['pi-category', ['Phone', 'Tablet', 'Watch', 'Buds']]]
    .forEach(([id, opts]) => { const el = document.getElementById(id); opts.forEach((v) => { const o = makeEl('option'); o.value = v; o.textContent = v; el.appendChild(o); }); });
  let confirmImpl = () => true, promptImpl = () => null;
  const alerts = [];
  let lastBlobText = null;
  function BlobStub(parts) { lastBlobText = Array.isArray(parts) ? parts.join('') : String(parts == null ? '' : parts); }
  function FileReaderStub() { this.onload = null; this.result = ''; }
  FileReaderStub.prototype.readAsText = function readAsText(file) {
    this.result = file && file.__text != null ? file.__text : '';
    if (this.onload) this.onload({ target: this });
  };
  const code = (() => {
    const html = fs.readFileSync(new URL('../d3-price/index.html', import.meta.url), 'utf8');
    const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/g);
    if (!m) throw new Error('Product Intake IIFE not found in index.html');
    return m[m.length - 1].replace(/^<script>/, '').replace(/<\/script>$/, '');
  })();
  const cryptoStub = { randomUUID: (() => { let n = 0; return () => `uid-${++n}`; })() };
  const fn = new Function('document', 'localStorage', 'crypto', 'confirm', 'alert', 'prompt', 'Blob', 'URL', 'FileReader', 'console', code);
  fn(document, localStorage, cryptoStub,
    (...a) => confirmImpl(...a), (m) => alerts.push(m), (...a) => promptImpl(...a),
    BlobStub, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, FileReaderStub, console);
  return {
    byId, alerts,
    setConfirm: (f) => { confirmImpl = f; },
    setPrompt: (f) => { promptImpl = f; },
    registry: () => JSON.parse(store.get('d3_merchant_registry') || '[]'),
    setRegistry: (v) => store.set('d3_merchant_registry', JSON.stringify(v)),
    products: () => JSON.parse(store.get('d3_product_intake') || '[]'),
    setProducts: (v) => store.set('d3_product_intake', JSON.stringify(v)),
    dropdownNames: () => byId['pi-merchant'].children.filter((c) => c.tag === 'option').map((o) => o._value),
    dropdownValue: () => byId['pi-merchant'].value,
    openManage: () => byId['pi-manage-merchant'].click(),
    manageNames: () => byId['pi-merchant-list'].children
      .map((row) => (row.children[0] ? String(row.children[0].innerHTML) : '')),
    findDeleteBtn: (name) => {
      for (const row of byId['pi-merchant-list'].children) {
        const left = row.children[0], right = row.children[1];
        if (left && String(left.innerHTML).includes(name) && right) {
          const b = right.children.find((x) => x.textContent === 'Delete');
          if (b) return b;
        }
      }
      return null;
    },
    findEditBtn: (name) => {
      for (const row of byId['pi-merchant-list'].children) {
        const left = row.children[0], right = row.children[1];
        if (left && String(left.innerHTML).includes(name) && right) {
          const b = right.children.find((x) => x.textContent === 'Edit');
          if (b) return b;
        }
      }
      return null;
    },
    openModal: () => document.getElementById('pi-launch').click(),
    // Fill the add-product form and submit it (mirrors a user clicking "Add Product").
    addProduct: ({ url = '', model = '', merchant = '', ram = '', storage = '' }) => {
      document.getElementById('pi-url').value = url; document.getElementById('pi-model').value = model;
      document.getElementById('pi-ram').value = ram; document.getElementById('pi-storage').value = storage;
      if (merchant) document.getElementById('pi-merchant').value = merchant;
      document.getElementById('pi-form').dispatch('submit', { preventDefault() {} });
    },
    msg: () => document.getElementById('pi-msg').textContent,
    statsText: () => String(document.getElementById('pi-stats').innerHTML),
    exportCsv: () => { lastBlobText = null; document.getElementById('pi-export').click(); return lastBlobText; },
    importCsv: (text) => {
      const f = document.getElementById('pi-import-file'); f.files = [{ __text: text }];
      f.dispatch('change', { target: f });
    },
  };
}

test('IIFE seeds the 4 default merchants into the dropdown', () => {
  const env = makeEnv();
  assert.deepEqual(env.dropdownNames(), ['D3', 'Deal Direct', 'TAC', 'Spray']);
  assert.ok(env.registry().every((m) => m.is_default === true));
});

test('add TEST_DELETE → delete → gone from localStorage, dropdown, and manage list', () => {
  const env = makeEnv();
  // add
  env.setPrompt(() => 'TEST_DELETE');
  env.setConfirm(() => false); // competitor
  env.byId['pi-add-merchant'].click();
  assert.ok(env.registry().some((m) => m.merchant_name === 'TEST_DELETE'), 'added to registry');
  assert.ok(env.dropdownNames().includes('TEST_DELETE'), 'added to dropdown');
  assert.equal(env.dropdownValue(), 'TEST_DELETE', 'newly added becomes selected');
  // delete (it is the currently selected one → also exercises req#5 reset)
  env.openManage();
  const btn = env.findDeleteBtn('TEST_DELETE');
  assert.ok(btn, 'Delete button rendered for self-made merchant');
  env.setConfirm(() => true);
  btn.click();
  assert.ok(!env.registry().some((m) => m.merchant_name === 'TEST_DELETE'), 'removed from registry');
  assert.ok(!env.dropdownNames().includes('TEST_DELETE'), 'removed from dropdown');
  assert.ok(!env.manageNames().some((n) => n.includes('TEST_DELETE')), 'removed from manage list');
  assert.equal(env.dropdownValue(), 'D3', 'selection reset to first merchant after deleting selected one');
});

test('delete removes stale same-name duplicate registry rows too', () => {
  const env = makeEnv();
  const reg = env.registry();
  reg.push({ id: 'dup-1', merchant_name: 'DUPME', merchant_type: 'competitor', status: 'active', is_default: false });
  reg.push({ id: 'dup-2', merchant_name: 'DUPME', merchant_type: 'competitor', status: 'active', is_default: false });
  env.setRegistry(reg);
  env.openManage();
  env.setConfirm(() => true);
  env.findDeleteBtn('DUPME').click();
  assert.ok(!env.registry().some((m) => m.merchant_name === 'DUPME'), 'all DUPME rows removed');
  assert.ok(!env.dropdownNames().includes('DUPME'));
});

test('default merchants expose no Delete/Edit button and cannot be deleted', () => {
  const env = makeEnv();
  env.openManage();
  assert.equal(env.findDeleteBtn('D3'), null);
  assert.equal(env.findEditBtn('D3'), null);
  assert.deepEqual(env.dropdownNames(), ['D3', 'Deal Direct', 'TAC', 'Spray']);
});

test('delete is blocked when a product still uses the merchant', () => {
  const env = makeEnv();
  const reg = env.registry();
  reg.push({ id: 'mid', merchant_name: 'INUSE', merchant_type: 'competitor', status: 'active', is_default: false });
  env.setRegistry(reg);
  env.setProducts([{ id: 'p1', merchant_name: 'INUSE', model_name: 'X', status: 'Active' }]);
  env.openManage();
  env.setConfirm(() => true);
  env.findDeleteBtn('INUSE').click();
  assert.ok(env.registry().some((m) => m.merchant_name === 'INUSE'), 'still present (blocked)');
  assert.ok(env.alerts.some((a) => /used by existing products/.test(a)), 'shows the guard message');
});

test('rename cascades to product_intake merchant_name', () => {
  const env = makeEnv();
  const reg = env.registry();
  reg.push({ id: 'mid', merchant_name: 'OLDNAME', merchant_type: 'competitor', status: 'active', is_default: false });
  env.setRegistry(reg);
  env.setProducts([{ id: 'p1', merchant_name: 'OLDNAME', model_name: 'X', status: 'Active' }]);
  env.openManage();
  env.setPrompt(() => 'NEWNAME');
  env.findEditBtn('OLDNAME').click();
  assert.ok(env.dropdownNames().includes('NEWNAME'), 'dropdown shows new name');
  assert.ok(!env.dropdownNames().includes('OLDNAME'), 'old name gone from dropdown');
  assert.equal(env.products()[0].merchant_name, 'NEWNAME', 'product cascaded to new name');
});

// ── Product CRUD / validation / URL parser / export / import / stats ─────────

test('add product requires URL, Model, and Merchant (nothing saved if missing)', () => {
  const env = makeEnv();
  env.addProduct({ url: '', model: 'Galaxy S26', merchant: 'D3' });          // no url
  assert.equal(env.products().length, 0);
  env.addProduct({ url: 'https://shopee.com.my/x-i.1.2', model: '', merchant: 'D3' }); // no model
  assert.equal(env.products().length, 0);
  // merchant blank: clear the select so value is empty
  env.byId['pi-merchant'].innerHTML = '';
  env.addProduct({ url: 'https://shopee.com.my/x-i.1.2', model: 'Galaxy S26' });
  assert.equal(env.products().length, 0);
  assert.match(env.msg(), /必填/);
});

test('Shopee URL parser handles i.<shop>.<item> and product/<shop>/<item>', () => {
  const env = makeEnv();
  env.addProduct({ url: 'https://shopee.com.my/Samsung-Galaxy-i.123456.789012', model: 'Galaxy S26', merchant: 'D3' });
  env.addProduct({ url: 'https://shopee.com.my/product/123456/789013', model: 'Galaxy A56', merchant: 'D3' });
  const ps = env.products();
  assert.equal(ps.length, 2);
  const byModel = Object.fromEntries(ps.map((p) => [p.model_name, p]));
  assert.equal(byModel['Galaxy S26'].shop_id, '123456');
  assert.equal(byModel['Galaxy S26'].item_id, '789012');
  assert.equal(byModel['Galaxy A56'].shop_id, '123456');
  assert.equal(byModel['Galaxy A56'].item_id, '789013');
});

test('Export Active Products emits the v2 header and only Active rows', () => {
  const env = makeEnv();
  env.setProducts([
    { id: 'a', merchant_name: 'D3', item_id: '789012', shop_id: '123456', model_name: 'Galaxy S26', ram: '12GB', storage: '256GB', category: 'Phone', shopee_url: 'https://shopee.com.my/x-i.123456.789012', status: 'Active' },
    { id: 'b', merchant_name: 'TAC', item_id: '11', shop_id: '22', model_name: 'Watch S5', ram: '', storage: '', category: 'Watch', shopee_url: 'https://shopee.com.my/y-i.22.11', status: 'Ignore' },
  ]);
  const csv = env.exportCsv();
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'merchant,item_id,shop_id,model_name,ram,storage,category,shopee_url,status');
  assert.equal(lines[0], PRODUCT_INTAKE_CSV_HEADER.join(','));
  assert.equal(lines.length, 2, 'header + 1 active row (ignored row excluded)');
  assert.equal(lines[1], 'D3,789012,123456,Galaxy S26,12GB,256GB,Phone,https://shopee.com.my/x-i.123456.789012,Active');
});

test('Export → Import round-trips products and auto-registers unknown merchants', () => {
  const a = makeEnv();
  a.setProducts([
    { id: 'a', merchant_name: 'NEWSHOP', item_id: '789012', shop_id: '123456', model_name: 'Galaxy S26', ram: '12GB', storage: '256GB', category: 'Phone', shopee_url: 'https://shopee.com.my/x-i.123456.789012', status: 'Active' },
  ]);
  const csv = a.exportCsv();
  // fresh machine
  const b = makeEnv();
  assert.equal(b.products().length, 0);
  assert.ok(!b.dropdownNames().includes('NEWSHOP'));
  b.importCsv(csv);
  assert.equal(b.products().length, 1, 'product imported');
  const p = b.products()[0];
  assert.equal(p.merchant_name, 'NEWSHOP');
  assert.equal(p.item_id, '789012');
  assert.equal(p.shop_id, '123456');
  assert.ok(b.dropdownNames().includes('NEWSHOP'), 'unknown merchant auto-registered into dropdown');
  // re-import same CSV → all skipped (dedup)
  b.importCsv(csv);
  assert.equal(b.products().length, 1, 'duplicate import skipped');
});

test('statistics card counts active / ignored / total products and merchants', () => {
  const env = makeEnv();
  env.setProducts([
    { id: '1', merchant_name: 'D3', model_name: 'A', status: 'Active' },
    { id: '2', merchant_name: 'D3', model_name: 'B', status: 'Active' },
    { id: '3', merchant_name: 'D3', model_name: 'C', status: 'Ignore' },
  ]);
  env.openModal(); // triggers renderList → renderStats
  const s = env.statsText();
  assert.match(s, /<div class="pi-stat-n">2<\/div><div class="pi-stat-l">Active Products/);
  assert.match(s, /<div class="pi-stat-n">1<\/div><div class="pi-stat-l">Ignored Products/);
  assert.match(s, /<div class="pi-stat-n">3<\/div><div class="pi-stat-l">Total Products/);
  assert.match(s, /<div class="pi-stat-n">4<\/div><div class="pi-stat-l">Total Merchants/);
});

// ── src/intake-products.mjs: Phase-2 reader understands the v2 export ────────

test('intakeRowsFromCsv maps the v2 export header to loadProducts shape', () => {
  const csv = `${PRODUCT_INTAKE_CSV_HEADER.join(',')}\n`
    + 'Deal Direct,789012,123456,Galaxy S26,12GB,256GB,Phone,https://shopee.com.my/x-i.123456.789012,Active\n'
    + 'TAC,11,22,Watch S5,,,Watch,https://shopee.com.my/y-i.22.11,Ignore\n';
  const rows = intakeRowsFromCsv(csv);
  assert.equal(rows.length, 1, 'only Active row kept');
  assert.equal(rows[0].our_product, 'Galaxy S26');
  assert.equal(rows[0].competitor, 'Deal Direct');
  assert.equal(rows[0].product_url, 'https://shopee.com.my/x-i.123456.789012');
  assert.equal(rows[0].variant, '12GB 256GB');
});

// ── Phase 2: sweep integration (mergeProducts / loadSweepProducts) ───────────

const baseProd = (competitor, url) => ({ our_product: 'x', competitor, product_url: url, status: 'active' });

test('mergeProducts(base, []) is identical to base (intake file missing → zero impact)', () => {
  const base = [baseProd('D3', 'https://shopee.com.my/a-i.1.2'), baseProd('TAC', 'https://shopee.com.my/b-i.3.4')];
  const merged = mergeProducts(base, []);
  assert.deepEqual(merged, base);
  assert.equal(merged.length, base.length);
});

test('mergeProducts dedups by merchant+item_id, then merchant+url', () => {
  const base = [baseProd('D3', 'https://shopee.com.my/a-i.111.222')];
  const intake = [
    baseProd('D3', 'https://shopee.com.my/DIFFERENT-SLUG-i.111.222'), // same merchant+item_id → skip
    baseProd('D3', 'https://shopee.com.my/c-i.111.999'),              // same merchant, diff item → keep
    baseProd('TAC', 'https://shopee.com.my/no-ids-here'),             // no item_id → keyed by url → keep
    baseProd('TAC', 'https://shopee.com.my/no-ids-here'),             // exact dup url → skip
  ];
  const merged = mergeProducts(base, intake);
  assert.equal(merged.length, 3, '1 base + 2 unique intake');
  assert.ok(merged.some((p) => p.product_url.includes('c-i.111.999')));
  assert.equal(merged.filter((p) => p.product_url === 'https://shopee.com.my/no-ids-here').length, 1);
});

function writeIntake(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake2-'));
  const file = path.join(dir, 'product-intake.csv');
  fs.writeFileSync(file, `${PRODUCT_INTAKE_CSV_HEADER.join(',')}\n${rows.join('\n')}\n`);
  return { dir, file };
}

test('loadSweepProducts: no file → base unchanged, logs base/intake/merged', () => {
  const logs = [];
  const base = [baseProd('D3', 'https://shopee.com.my/a-i.1.2')];
  const merged = loadSweepProducts(base, { log: (m) => logs.push(m), csvPath: '/nonexistent/product-intake.csv' });
  assert.deepEqual(merged, base);
  assert.ok(logs.some((l) => /\[products\] base=1 intake=0 merged=1 skipped_duplicates=0/.test(l)), logs.join('|'));
});

test('loadSweepProducts: Active enters, Ignore excluded, duplicates skipped', () => {
  const { dir, file } = writeIntake([
    'D3,222,111,Galaxy S26,12GB,256GB,Phone,https://shopee.com.my/a-i.111.222,Active', // dup of base → skip
    'NEWSHOP,999,888,Galaxy A56,8GB,128GB,Phone,https://shopee.com.my/c-i.888.999,Active', // new → keep
    'TAC,11,22,Watch S5,,,Watch,https://shopee.com.my/d-i.22.11,Ignore', // ignored → never loaded
  ]);
  const logs = [];
  const base = [baseProd('D3', 'https://shopee.com.my/a-i.111.222')];
  const merged = loadSweepProducts(base, { log: (m) => logs.push(m), csvPath: file });
  assert.equal(merged.length, 2, 'base(1) + 1 new active');
  assert.ok(merged.some((p) => p.competitor === 'NEWSHOP'));
  assert.ok(!merged.some((p) => p.competitor === 'TAC'), 'Ignore never enters');
  assert.ok(logs.some((l) => /\[products\] base=1 intake=2 merged=2 skipped_duplicates=1/.test(l)), logs.join('|'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadSweepProducts: broken CSV path (a directory) → warning, no crash, base kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake2-'));
  const logs = [];
  const base = [baseProd('D3', 'https://shopee.com.my/a-i.1.2')];
  // pass the directory itself as csvPath → readFileSync throws EISDIR → caught + warned
  const merged = loadSweepProducts(base, { log: (m) => logs.push(m), csvPath: dir });
  assert.deepEqual(merged, base, 'base survives a broken intake read');
  assert.ok(logs.some((l) => /WARN intake/.test(l)), 'a warning was logged');
  fs.rmSync(dir, { recursive: true, force: true });
});
