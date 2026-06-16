// 手表型号解析测试 —— resolveWatchModel + parseVariantDescriptor。
// 跑：node --test scripts/test-watch-model.mjs   （或 node scripts/test-watch-model.mjs）
// 验证：① 多家族同串 drop（不被首个家族误分类）；② 单家族泛型标签；③ 手机/平板的 "Ultra" 不被劫持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWatchModel, parseVariantDescriptor } from '../src/variant-parser.mjs';

// ── 1) multi-family-drop 断言（两条）──────────────────────────────────────
test('multi-family-drop ①：营销标题 "Watch 8 Classic Watch Ultra 2025" → ""（交 itemModel 定）', () => {
  assert.equal(resolveWatchModel('Samsung Galaxy Watch 8 Classic Watch Ultra 2025'), '');
});

test('multi-family-drop ②：mixed "Watch Ultra / Watch 8 / Watch 8 Classic" → ""', () => {
  assert.equal(resolveWatchModel('Watch Ultra / Watch 8 / Watch 8 Classic'), '');
});

// ── 2) 控制测试：单家族手表正确分类 ───────────────────────────────────────
test('Watch8 控制：无空格 standalone "Watch8 40mm Graphite" → "Watch 8"', () => {
  assert.equal(resolveWatchModel('Watch8 40mm Graphite'), 'Watch 8');
});

test('Ultra 控制：standalone "Watch Ultra 47mm LTE" → "Watch Ultra 2025"（无码 Ultra 归 canonical）', () => {
  assert.equal(resolveWatchModel('Watch Ultra 47mm LTE'), 'Watch Ultra 2025');
});

test('Watch 8 Classic 控制：单家族保留 Classic → "Watch 8 Classic"', () => {
  assert.equal(resolveWatchModel('Galaxy Watch 8 Classic 46mm BT'), 'Watch 8 Classic');
});

// L705N 已加进 samsung-master 代号表 → code-first（lookupWearableByCode，在 resolveWatchModel 之前）命中，
// 必须归 "Watch Ultra 2025"，confidence=confirmed；不可输出泛型 "Watch Ultra"。
test('L705N 必须归 "Watch Ultra 2025"（code-first），不可是泛型 "Watch Ultra"', () => {
  const r = parseVariantDescriptor('SAMSUNG Galaxy Watch Ultra LTE 47mm (L705N) Titanium Gray');
  assert.equal(r.model, 'Watch Ultra 2025');
  assert.equal(r.confidence, 'confirmed');
  assert.notEqual(r.model, 'Watch Ultra');
});

// Step 2：title 同含 Watch 8 / Watch 8 Classic / Watch Ultra，且 variant 名无明确型号/尺寸（只有颜色）
// → 必须 drop（model=''），不可 fallback 成 Watch 8 / Watch Ultra。
test('multi-family-drop 集成：多家族 title + 无型号 variant → drop（不 fallback）', () => {
  const r = parseVariantDescriptor('Titanium Silver', {
    title: 'Samsung Galaxy Watch 8 Watch 8 Classic Watch Ultra 2025 Original Set',
    itemModel: 'Watch Ultra / Watch 8 / Watch 8 Classic Mixed',
  });
  assert.equal(r.model, '');
  assert.notEqual(r.model, 'Watch 8');
  assert.notEqual(r.model, 'Watch Ultra');
});

// ── 3) 控制测试：手机 / 平板的 "Ultra" 绝不被当成 Watch Ultra ───────────────
test('phone 控制：S25 Ultra 不被劫持', () => {
  assert.equal(resolveWatchModel('Samsung Galaxy S25 Ultra 12+256GB'), '');
  assert.equal(parseVariantDescriptor('Samsung Galaxy S25 Ultra (12+256GB)').model, 'S25 Ultra');
});

test('tablet 控制：Tab S11 Ultra 不被劫持', () => {
  assert.equal(resolveWatchModel('Tab S11 Ultra WiFi 256GB'), '');
  // 平板按设计补网络后缀 → "Tab S11 Ultra WiFi"；控制点是「没被当成 Watch Ultra」。
  assert.equal(parseVariantDescriptor('Samsung Galaxy Tab S11 Ultra WiFi 256GB').model, 'Tab S11 Ultra WiFi');
});
