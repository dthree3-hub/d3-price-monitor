#!/usr/bin/env python3
# 极简 xlsx 写入器（纯标准库 zipfile + XML）。支持表头 + 自动筛选(排序) + 指定行标红。
# 用法: python3 audit_xlsx.py <rows.json> <out.xlsx>
# rows.json 格式: {"headers":[...], "rows":[[cell,...],...], "highlight":[rowIdx,...]}（rowIdx 从 0 数据行起）
import sys, json, zipfile, re

def col_letter(n):  # 0->A
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def esc(v):
    return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))

def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)

def build(headers, rows, highlight):
    hl = set(highlight or [])
    ncols = len(headers)
    last_col = col_letter(ncols - 1)
    nrows = len(rows) + 1
    # cells
    def cell(ref, val, style):
        s = f' s="{style}"' if style else ""
        if is_num(val):
            return f'<c r="{ref}"{s}><v>{val}</v></c>'
        return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{esc(val)}</t></is></c>'
    sheet_rows = []
    # header row (style 1 = bold header)
    hc = "".join(cell(f"{col_letter(j)}1", headers[j], 1) for j in range(ncols))
    sheet_rows.append(f'<row r="1">{hc}</row>')
    for i, row in enumerate(rows):
        rownum = i + 2
        style = 2 if i in hl else 0  # style 2 = 红底
        cs = "".join(cell(f"{col_letter(j)}{rownum}", row[j] if j < len(row) else "", style) for j in range(ncols))
        sheet_rows.append(f'<row r="{rownum}">{cs}</row>')
    dim = f"A1:{last_col}{nrows}"
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<dimension ref="{dim}"/>'
             '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>'
             '<sheetFormatPr defaultRowHeight="15"/>'
             f'<sheetData>{"".join(sheet_rows)}</sheetData>'
             f'<autoFilter ref="A1:{last_col}{nrows}"/>'
             '</worksheet>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
              '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill>'
              '<fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill></fills>'
              '<borders count="1"><border/></borders>'
              '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
              '<cellXfs count="3">'
              '<xf fontId="0" fillId="0" borderId="0"/>'           # 0 normal
              '<xf fontId="1" fillId="0" borderId="0"/>'           # 1 bold header
              '<xf fontId="0" fillId="2" borderId="0" applyFill="1"/>'  # 2 红底
              '</cellXfs>'
              '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
              '</styleSheet>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                     '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                     '</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                 '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Samsung Audit" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
               '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
               '</Relationships>')
    return {
        "[Content_Types].xml": content_types,
        "_rels/.rels": root_rels,
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": wb_rels,
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sheet,
    }

def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    files = build(spec["headers"], spec["rows"], spec.get("highlight", []))
    with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    print(f"wrote {sys.argv[2]} ({len(spec['rows'])} rows, {len(spec.get('highlight',[]))} highlighted)")

if __name__ == "__main__":
    main()
