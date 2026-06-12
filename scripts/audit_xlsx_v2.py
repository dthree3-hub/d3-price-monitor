#!/usr/bin/env python3
# 多 Sheet xlsx 写入器（纯标准库）。支持每行三色状态（绿=FIXED/黄=PARTIAL/红=OPEN）+ 表头加粗 + 冻结首行 + 自动筛选。
# 用法: python3 audit_xlsx_v2.py <spec.json> <out.xlsx>
# spec: {"sheets":[{"name":..,"headers":[..],"rows":[[..]],"colors":["green"|"yellow"|"red"|"", ..]}]}
import sys, json, zipfile

def col_letter(n):
    s = ""; n += 1
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s

def esc(v):
    return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))

def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)

STYLE = {"": 0, "green": 2, "yellow": 3, "red": 4}

def cell(ref, val, style):
    s = f' s="{style}"' if style else ""
    if is_num(val):
        return f'<c r="{ref}"{s}><v>{val}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{esc(val)}</t></is></c>'

def sheet_xml(headers, rows, colors):
    ncols = len(headers); last = col_letter(ncols - 1); nrows = len(rows) + 1
    out = []
    hc = "".join(cell(f"{col_letter(j)}1", headers[j], 1) for j in range(ncols))
    out.append(f'<row r="1">{hc}</row>')
    for i, row in enumerate(rows):
        rn = i + 2
        st = STYLE.get((colors[i] if i < len(colors) else "") or "", 0)
        cs = "".join(cell(f"{col_letter(j)}{rn}", row[j] if j < len(row) else "", st) for j in range(ncols))
        out.append(f'<row r="{rn}">{cs}</row>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<dimension ref="A1:{last}{nrows}"/>'
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'
            '<sheetFormatPr defaultRowHeight="15"/>'
            f'<sheetData>{"".join(out)}</sheetData>'
            f'<autoFilter ref="A1:{last}{nrows}"/></worksheet>')

def build(sheets):
    files = {}
    sheet_entries, rels, ctypes = [], [], []
    for idx, sh in enumerate(sheets, 1):
        files[f"xl/worksheets/sheet{idx}.xml"] = sheet_xml(sh["headers"], sh["rows"], sh.get("colors", []))
        name = esc(sh["name"])[:31]
        sheet_entries.append(f'<sheet name="{name}" sheetId="{idx}" r:id="rId{idx}"/>')
        rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
        ctypes.append(f'<Override PartName="/xl/worksheets/sheet{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    styles_rid = len(sheets) + 1
    rels.append(f'<Relationship Id="rId{styles_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
    files["xl/styles.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill>'   # 2 green
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/></patternFill></fill>'   # 3 yellow
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill></fills>'  # 4 red
        '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>'
        '<cellXfs count="5">'
        '<xf fontId="0" fillId="0" borderId="0"/>'
        '<xf fontId="1" fillId="0" borderId="0"/>'
        '<xf fontId="0" fillId="2" borderId="0" applyFill="1"/>'
        '<xf fontId="0" fillId="3" borderId="0" applyFill="1"/>'
        '<xf fontId="0" fillId="4" borderId="0" applyFill="1"/>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    files["[Content_Types].xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + "".join(ctypes) +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
    files["_rels/.rels"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    files["xl/workbook.xml"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(sheet_entries)}</sheets></workbook>')
    files["xl/_rels/workbook.xml.rels"] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(rels) + '</Relationships>')
    return files

def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    files = build(spec["sheets"])
    with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    print(f"wrote {sys.argv[2]} ({len(spec['sheets'])} sheets)")

if __name__ == "__main__":
    main()
