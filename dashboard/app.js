const REMOTE_DATA_URL = new URL('../data/records.json', window.location.href).href;
const STORAGE_KEY = 'd3-price-console-records-v1';

const state = {
  records: [],
  search: '',
  source: 'Loading data/records.json ...',
};

const fileInput = document.getElementById('fileInput');
const exportCsvButton = document.getElementById('exportCsv');
const exportJsonButton = document.getElementById('exportJson');
const clearButton = document.getElementById('clearAll');
const dropzone = document.getElementById('dropzone');
const pasteInput = document.getElementById('pasteInput');
const importPasteButton = document.getElementById('importPaste');
const searchInput = document.getElementById('searchInput');
const tableBody = document.getElementById('tableBody');
const dropList = document.getElementById('dropList');

const metricProducts = document.getElementById('metricProducts');
const metricVariants = document.getElementById('metricVariants');
const metricShops = document.getElementById('metricShops');
const metricLatest = document.getElementById('metricLatest');
const metricDrops = document.getElementById('metricDrops');
const metricMaxDrop = document.getElementById('metricMaxDrop');
bootstrap();

async function bootstrap() {
  const embedded = Array.isArray(window.D3_EMBEDDED_RECORDS)
    ? window.D3_EMBEDDED_RECORDS.map(normalizeRecord).filter(Boolean)
    : [];

  if (embedded.length) {
    state.records = sortRecords(embedded);
    state.source = `Showing embedded snapshot data (${state.records.length} records).`;
    persistLocalRecords();
    bindEvents();
    render();
    return;
  }

  const local = loadLocalRecords();
  if (local.length) {
    state.records = sortRecords(local);
    state.source = 'Showing locally cached browser data.';
    render();
  } else {
    render();
  }

  try {
    const response = await fetch(`${REMOTE_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const remote = Array.isArray(payload) ? payload : [];
    state.records = sortRecords(remote.map(normalizeRecord).filter(Boolean));
    state.source = `Loaded ${state.records.length} records from ${REMOTE_DATA_URL}.`;
    persistLocalRecords();
  } catch (error) {
    if (!state.records.length) {
      state.source = 'Could not auto-load data/records.json. Please import JSON manually.';
    } else {
      state.source = `Remote load failed. Continuing with local cache. Reason: ${error.message}`;
    }
  }

  bindEvents();
  render();
}

function bindEvents() {
  fileInput.addEventListener('change', async (event) => {
    await importFiles(event.target.files);
    fileInput.value = '';
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.style.borderColor = '#9a6b16';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = '';
  });

  dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.style.borderColor = '';
    await importFiles(event.dataTransfer.files);
  });

  importPasteButton.addEventListener('click', () => {
    if (!pasteInput.value.trim()) return;
    try {
      const payload = JSON.parse(pasteInput.value);
      mergeIncoming(Array.isArray(payload) ? payload : [payload], 'Pasted JSON imported.');
      pasteInput.value = '';
    } catch (error) {
      alert(`JSON parse failed: ${error.message}`);
    }
  });

  searchInput.addEventListener('input', () => {
    state.search = searchInput.value.trim().toLowerCase();
    render();
  });

  exportCsvButton.addEventListener('click', () => {
    const csv = buildCsv(flattenRecords(filteredRecords()));
    downloadFile('d3-price-console.csv', csv, 'text/csv;charset=utf-8');
  });

  exportJsonButton.addEventListener('click', () => {
    downloadFile(
      'd3-price-console.json',
      JSON.stringify(state.records, null, 2),
      'application/json'
    );
  });

  clearButton.addEventListener('click', () => {
    if (!window.confirm('Clear all records currently shown in this console?')) return;
    state.records = [];
    state.source = 'Current data has been cleared.';
    persistLocalRecords();
    render();
  });
}

function loadLocalRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistLocalRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  } catch {
    // 忽略 file:// 或隐私模式下的存储失败
  }
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const incoming = [];
  for (const file of files) {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) incoming.push(...payload);
    else incoming.push(payload);
  }

  mergeIncoming(incoming, `Imported ${files.length} JSON file(s).`);
}

function mergeIncoming(items, sourceText) {
  const incoming = items.map(normalizeRecord).filter(Boolean);
  const byKey = new Map(state.records.map((record) => [recordKey(record), record]));
  for (const record of incoming) {
    byKey.set(recordKey(record), record);
  }

  state.records = sortRecords(Array.from(byKey.values()));
  state.source = sourceText;
  persistLocalRecords();
  render();
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!Array.isArray(record.variants)) return null;

  return {
    schemaVersion: Number(record.schemaVersion || 1),
    grabbedAt: String(record.grabbedAt || new Date().toISOString()),
    pageUrl: String(record.pageUrl || ''),
    shopId: String(record.shopId || ''),
    itemId: String(record.itemId || ''),
    sellerName: String(record.sellerName || ''),
    title: String(record.title || 'Untitled product'),
    currency: String(record.currency || 'MYR'),
    variants: record.variants
      .map((variant) => ({
        name: String(variant.name || 'Default variant'),
        currentPrice: toNumberOrNull(variant.currentPrice),
        originalPrice: toNumberOrNull(variant.originalPrice),
        promoPrice: toNumberOrNull(variant.promoPrice),
        stock: variant.stock == null ? null : Number(variant.stock),
        inStock: Boolean(variant.inStock),
      }))
      .filter(Boolean),
  };
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recordKey(record) {
  return `${record.shopId}:${record.itemId}:${record.grabbedAt}`;
}

function variantIdentity(record, variant) {
  return `${record.shopId}:${record.itemId}:${variant.name}`;
}

function sortRecords(records) {
  return [...records].sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
}

function filteredRecords() {
  if (!state.search) return state.records;
  return state.records.filter((record) => {
    const haystack = [
      record.title,
      record.sellerName,
      record.shopId,
      record.itemId,
      ...record.variants.map((variant) => variant.name),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(state.search);
  });
}

function flattenRecords(records) {
  return records.flatMap((record) =>
    record.variants.map((variant) => ({
      grabbedAt: record.grabbedAt,
      title: record.title,
      sellerName: record.sellerName,
      pageUrl: record.pageUrl,
      shopId: record.shopId,
      itemId: record.itemId,
      variantName: variant.name,
      currentPrice: variant.currentPrice,
      originalPrice: variant.originalPrice,
      promoPrice: variant.promoPrice,
      inStock: variant.inStock,
      stock: variant.stock,
    }))
  );
}

function buildCsv(rows) {
  const header = [
    'grabbed_at',
    'title',
    'seller_name',
    'page_url',
    'shop_id',
    'item_id',
    'variant_name',
    'current_price',
    'original_price',
    'promo_price',
    'in_stock',
    'stock',
  ];

  const lines = [header]
    .concat(
      rows.map((row) => [
        row.grabbedAt,
        row.title,
        row.sellerName,
        row.pageUrl,
        row.shopId,
        row.itemId,
        row.variantName,
        row.currentPrice ?? '',
        row.originalPrice ?? '',
        row.promoPrice ?? '',
        row.inStock ? 'true' : 'false',
        row.stock ?? '',
      ])
    )
    .map((cells) => cells.map(csvCell).join(','));

  return lines.join('\n');
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadFile(name, body, type) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildDropReport(records) {
  const byVariant = new Map();

  for (const record of records) {
    for (const variant of record.variants) {
      const key = variantIdentity(record, variant);
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key).push({
        grabbedAt: record.grabbedAt,
        title: record.title,
        sellerName: record.sellerName,
        pageUrl: record.pageUrl,
        shopId: record.shopId,
        itemId: record.itemId,
        variantName: variant.name,
        currentPrice: variant.currentPrice,
      });
    }
  }

  const drops = [];
  for (const history of byVariant.values()) {
    history.sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
    if (history.length < 2) continue;

    const latest = history[0];
    const previous = history[1];
    if (latest.currentPrice == null || previous.currentPrice == null) continue;
    if (latest.currentPrice >= previous.currentPrice) continue;

    drops.push({
      ...latest,
      previousGrabbedAt: previous.grabbedAt,
      previousPrice: previous.currentPrice,
      dropAmount: Number((previous.currentPrice - latest.currentPrice).toFixed(2)),
    });
  }

  return drops.sort((a, b) => b.dropAmount - a.dropAmount);
}

function buildChangeReport(records) {
  const byVariant = new Map();

  for (const record of records) {
    for (const variant of record.variants) {
      const key = variantIdentity(record, variant);
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key).push({
        grabbedAt: record.grabbedAt,
        title: record.title,
        sellerName: record.sellerName,
        pageUrl: record.pageUrl,
        shopId: record.shopId,
        itemId: record.itemId,
        variantName: variant.name,
        currentPrice: variant.currentPrice,
        inStock: variant.inStock,
      });
    }
  }

  const changes = [];
  for (const history of byVariant.values()) {
    history.sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
    const latest = history[0];
    const previous = history[1] || null;
    let status = 'same';
    let delta = null;

    if (!previous) {
      status = 'new';
    } else if (latest.currentPrice != null && previous.currentPrice != null) {
      delta = Number((latest.currentPrice - previous.currentPrice).toFixed(2));
      if (delta > 0) status = 'up';
      else if (delta < 0) status = 'down';
    }

    changes.push({
      ...latest,
      previousPrice: previous?.currentPrice ?? null,
      previousGrabbedAt: previous?.grabbedAt ?? null,
      delta,
      status,
    });
  }

  return changes.sort((a, b) => {
    const bySeller = sellerLabel(a).localeCompare(sellerLabel(b));
    if (bySeller !== 0) return bySeller;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.variantName.localeCompare(b.variantName);
  });
}

function sellerLabel(record) {
  return record.sellerName || `Shop ${record.shopId || '-'}`;
}

function shortTitle(title) {
  return title.length > 64 ? `${title.slice(0, 64)}...` : title;
}

function formatPrice(value) {
  return value == null ? 'N/A' : `RM${value}`;
}

function formatStatus(change) {
  if (change.status === 'down') return `Price down ${formatPrice(Math.abs(change.delta))}`;
  if (change.status === 'up') return `Price up ${formatPrice(change.delta)}`;
  if (change.status === 'new') return 'First record';
  return 'No change';
}

function render() {
  const records = filteredRecords();
  const rows = flattenRecords(records);
  const drops = buildDropReport(records);

  metricProducts.textContent = String(records.length);
  metricVariants.textContent = String(rows.length);
  metricShops.textContent = String(new Set(records.map((record) => record.shopId)).size);
  metricLatest.textContent = records[0]?.grabbedAt?.replace('T', ' ').replace('Z', ' UTC') || '-';
  metricDrops.textContent = String(drops.length);
  metricMaxDrop.textContent = drops.length ? `RM${drops[0].dropAmount}` : '-';

  renderDropList(drops);

  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="8" class="muted">${escapeHtml(state.source)}</td></tr>`;
    return;
  }

  tableBody.innerHTML = rows
    .map((row) => {
      const price = row.currentPrice == null ? '-' : `RM${row.currentPrice}`;
      const original = row.originalPrice == null ? '-' : `RM${row.originalPrice}`;
      const stockClass = row.inStock ? 'pill' : 'pill out';
      const stockLabel = row.inStock ? `In stock${row.stock != null ? ` (${row.stock})` : ''}` : 'Out of stock';
      return `
        <tr>
          <td class="mono">${escapeHtml(row.grabbedAt)}</td>
          <td>
            <strong>${escapeHtml(row.title)}</strong><br>
            <span class="muted">${escapeHtml(row.sellerName || '-')}</span>
          </td>
          <td>${escapeHtml(row.variantName)}</td>
          <td>${escapeHtml(price)}</td>
          <td>${escapeHtml(original)}</td>
          <td><span class="${stockClass}">${escapeHtml(stockLabel)}</span></td>
          <td class="mono">${escapeHtml(row.shopId)} / ${escapeHtml(row.itemId)}</td>
          <td><a href="${escapeAttribute(row.pageUrl)}" target="_blank" rel="noreferrer">Open product page</a></td>
        </tr>
      `;
    })
    .join('');
}

function renderDropList(drops) {
  if (!drops.length) {
    dropList.innerHTML = `<div class="muted">${escapeHtml(state.source)} A drop report appears after the same variant has been captured at least twice.</div>`;
    return;
  }

  dropList.innerHTML = drops
    .map((drop) => {
      return `
        <article class="report-card">
          <strong>${escapeHtml(drop.title)}</strong>
          <div class="report-meta">${escapeHtml(drop.variantName)} · Shop ${escapeHtml(drop.sellerName || drop.shopId)}</div>
          <div class="report-meta">RM${escapeHtml(drop.previousPrice)} → RM${escapeHtml(drop.currentPrice)} (down RM${escapeHtml(drop.dropAmount)})</div>
          <div class="report-meta">Last ${escapeHtml(drop.previousGrabbedAt)} | Current ${escapeHtml(drop.grabbedAt)}</div>
        </article>
      `;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
