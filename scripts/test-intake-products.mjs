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

// ── Product Intake merchant-management IIFE (d3-price/index.html) ─────────────
// Runs the real browser IIFE under a minimal DOM/localStorage stub so the merchant
// CRUD (add / delete / rename / default-protection / used-by-product guard) is
// covered without a browser. Emulates <select>.value reset semantics so a delete
// of the selected merchant is verifiably reflected in the dropdown.

const SELECT_IDS = new Set(['pi-merchant', 'pi-category', 'pi-status']);

function makeEl(tag) {
  const el = {
    tag, children: [], listeners: {}, onclick: null, parent: null,
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
    setAttribute() {}, click() {
      if (typeof this.onclick === 'function') this.onclick({ target: this });
      (this.listeners.click || []).forEach((f) => f({ target: this }));
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
  let confirmImpl = () => true, promptImpl = () => null;
  const alerts = [];
  const code = (() => {
    const html = fs.readFileSync(new URL('../d3-price/index.html', import.meta.url), 'utf8');
    const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/g);
    if (!m) throw new Error('Product Intake IIFE not found in index.html');
    return m[m.length - 1].replace(/^<script>/, '').replace(/<\/script>$/, '');
  })();
  const cryptoStub = { randomUUID: (() => { let n = 0; return () => `uid-${++n}`; })() };
  const fn = new Function('document', 'localStorage', 'crypto', 'confirm', 'alert', 'prompt', 'Blob', 'URL', 'console', code);
  fn(document, localStorage, cryptoStub,
    (...a) => confirmImpl(...a), (m) => alerts.push(m), (...a) => promptImpl(...a),
    function () {}, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, console);
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
