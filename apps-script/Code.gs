// D3 价格数据盒子 —— Google Apps Script Web App
// doPost：书签把抓到的价格 JSON 送来 → 追加进 Google Sheet
// doGet ：网页来读全部数据（支持 JSONP，绕过跨域）
// 首次运行会自动在你的 Google Drive 建一张表「D3 价格数据」，不用手动建。

const SHEET_NAME = 'records';

function getSheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { id = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('D3 价格数据');
    props.setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['grabbedAt', 'shopId', 'itemId', 'title', 'json']);
  }
  return sh;
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const records = Array.isArray(data) ? data : [data];
    const sh = getSheet();
    for (const r of records) {
      sh.appendRow([r.grabbedAt || '', String(r.shopId || ''), String(r.itemId || ''), r.title || '', JSON.stringify(r)]);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: records.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  const sh = getSheet();
  const rows = sh.getDataRange().getValues();
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i][4];
    if (!cell) continue;
    try { records.push(JSON.parse(cell)); } catch (_) {}
  }
  const payload = JSON.stringify(records);
  const cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + '(' + payload + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}
