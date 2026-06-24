#!/usr/bin/env python3
"""
Build a polished, branded DOCX (and PDF when possible) from a report markdown file.

Zero configuration by design: the only input is the report markdown path. Everything
else is a fixed house format —
  * A4 portrait, 25/22/20 mm margins
  * tables: bordered, navy header row (white bold), alternating row banding, full width
  * a generated cover page (CONFIDENTIAL + title + target + metadata table)
  * heading spacing on the styles, justified body text
Cover text is parsed from the report's own "Document Control" table, so nothing needs
to be passed in. If `scripts/report-template.docx` exists it is used as the brand
reference (theme fonts + header/footer logo); otherwise the default theme is used.

Usage:
  python3 scripts/build-report.py <report.md>
  # -> writes <report>.docx beside the input, and <report>.pdf if LibreOffice is present
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

from docx import Document
from docx.shared import Pt, Mm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH as AL, WD_BREAK
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ROW_HEIGHT_RULE
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# === house format constants ===
ACCENT = "1F3364"        # navy — table header rows
TITLE_COLOR = "0060FF"   # Techvify brand blue — matches the header logo text; cover title
BAND = "EEF1F6"          # row banding
BORDER = "B7C0CE"        # table border
TEMPLATE_NAME = "report-template.docx"   # brand reference (Techvify header/footer), beside this script

# Cover metadata: which Document Control fields to surface, in this order.
# Keys are matched case-insensitively; the first present (non-empty/non-TBD) wins.
COVER_FIELDS = ["Target", "Report Version", "Version", "Assessment Cadence",
                "Assessment Date", "Assessment Window", "Date", "Classification", "Prepared By"]


def parse_document_control(md_text: str) -> tuple[str, list[tuple[str, str]]]:
    """Return (h1_title, [(field, value), ...]) parsed from the report markdown.

    Cover metadata comes from the first `Field | Value` table under a
    "Document Control" heading. Title is the first H1.
    """
    h1 = ""
    m = re.search(r"^#\s+(.+)$", md_text, re.MULTILINE)
    if m:
        h1 = m.group(1).strip()

    rows: list[tuple[str, str]] = []
    sec = re.search(r"^#{1,6}\s*Document Control\s*$", md_text, re.MULTILINE)
    if sec:
        tail = md_text[sec.end():]
        for line in tail.splitlines():
            s = line.strip()
            if s.startswith("|"):
                cells = [c.strip() for c in s.strip("|").split("|")]
                if len(cells) >= 2:
                    k, v = cells[0], cells[1]
                    if k.lower() == "field" or set(k) <= {"-", ":", " "}:
                        continue  # header / separator row
                    if k:
                        rows.append((k, v))
            elif s == "" and rows:
                break  # blank line after the table ends the block
            elif rows and not s.startswith("|"):
                break
    return h1, rows


# A4 (11906 tw) minus 25mm (1417 tw) margins each side -> ~9072 tw text width.
TEXT_WIDTH = 9072

# OOXML schema child-element order. Word tolerates wrong order; LibreOffice does
# NOT — a mis-ordered tblPr/tcPr makes it drop the table structure entirely (cells
# render empty, text spills out as loose paragraphs). So every element is inserted
# in its correct position, not appended.
_TBLPR_ORDER = ["w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual",
                "w:tblStyleRowBandSize", "w:tblStyleColBandSize", "w:tblW", "w:jc",
                "w:tblCellSpacing", "w:tblInd", "w:tblBorders", "w:shd", "w:tblLayout",
                "w:tblCellMar", "w:tblLook", "w:tblCaption", "w:tblDescription"]
_TCPR_ORDER = ["w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge",
               "w:tcBorders", "w:shd", "w:noWrap", "w:tcMar", "w:textDirection",
               "w:tcFit", "w:vAlign", "w:hideMark"]


def _ordered(parent, tag, order):
    """Replace/insert a child element `tag` into `parent` at its schema position."""
    for e in parent.findall(qn(tag)):
        parent.remove(e)
    el = OxmlElement(tag)
    successors = order[order.index(tag) + 1:]
    parent.insert_element_before(el, *successors)
    return el


# === table helpers ===
def _set_borders(t, color=BORDER, sz="4"):
    b = _ordered(t._tbl.tblPr, "w:tblBorders", _TBLPR_ORDER)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        x = OxmlElement("w:" + edge)
        x.set(qn("w:val"), "single")
        x.set(qn("w:sz"), sz)
        x.set(qn("w:space"), "0")
        x.set(qn("w:color"), color)
        b.append(x)


def _full_width(t, total=TEXT_WIDTH):
    """Span the text column with a FIXED layout + explicit column/cell widths.
    pct width + autofit renders as empty cells in LibreOffice's docx->pdf."""
    tbl = t._tbl
    pr = tbl.tblPr

    grid = tbl.find(qn("w:tblGrid"))
    cols = grid.findall(qn("w:gridCol")) if grid is not None else []
    widths = [int(g.get(qn("w:w")) or 0) for g in cols]
    s = sum(widths)
    if widths and s > 0:
        scaled = [max(1, round(w * total / s)) for w in widths]
        scaled[-1] += total - sum(scaled)   # absorb rounding so the sum is exact
    elif cols:
        each = total // len(cols)
        scaled = [each] * len(cols)
        scaled[-1] += total - sum(scaled)
    else:
        scaled = []
    for g, w in zip(cols, scaled):
        g.set(qn("w:w"), str(w))

    w = _ordered(pr, "w:tblW", _TBLPR_ORDER)
    w.set(qn("w:type"), "dxa")
    w.set(qn("w:w"), str(total))
    lay = _ordered(pr, "w:tblLayout", _TBLPR_ORDER)
    lay.set(qn("w:type"), "fixed")

    # fixed layout needs each cell to carry its own width
    for row in t.rows:
        cells = row.cells
        for ci, cell in enumerate(cells):
            wv = scaled[ci] if ci < len(scaled) else (total // max(1, len(cells)))
            e = _ordered(cell._tc.get_or_add_tcPr(), "w:tcW", _TCPR_ORDER)
            e.set(qn("w:type"), "dxa")
            e.set(qn("w:w"), str(int(wv)))


def _shade(cell, fill):
    s = _ordered(cell._tc.get_or_add_tcPr(), "w:shd", _TCPR_ORDER)
    s.set(qn("w:val"), "clear")
    s.set(qn("w:color"), "auto")
    s.set(qn("w:fill"), fill)


def _style_runs(cell, *, bold=None, color=None, size=None):
    for p in cell.paragraphs:
        for r in p.runs:
            if bold is not None:
                r.font.bold = bold
            if color is not None:
                r.font.color.rgb = color
            if size is not None:
                r.font.size = Pt(size)


def _cell_pad(cell, top=50, bottom=50, left=110, right=110):
    mar = _ordered(cell._tc.get_or_add_tcPr(), "w:tcMar", _TCPR_ORDER)
    for edge, val in (("top", top), ("bottom", bottom), ("start", left), ("end", right)):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:w"), str(val))
        e.set(qn("w:type"), "dxa")
        mar.append(e)


def _vcenter(cell):
    v = _ordered(cell._tc.get_or_add_tcPr(), "w:vAlign", _TCPR_ORDER)
    v.set(qn("w:val"), "center")


def _add_bookmark(paragraph, name, bmid):
    """Wrap a heading paragraph in a bookmark so the TOC can link to it."""
    p = paragraph._p
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bmid))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bmid))
    pPr = p.find(qn("w:pPr"))
    if pPr is not None:
        pPr.addnext(start)
    else:
        p.insert(0, start)
    p.append(end)


def _toc_entry(doc, text, anchor, level, color):
    """A clickable TOC line (no page number — renders reliably everywhere)."""
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.28 * (level - 1))
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.keep_with_next = False
    h = OxmlElement("w:hyperlink")
    h.set(qn("w:anchor"), anchor)
    r = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    if level == 1:
        rPr.append(OxmlElement("w:b"))
    sz = OxmlElement("w:sz"); sz.set(qn("w:val"), "23" if level == 1 else "21"); rPr.append(sz)
    col = OxmlElement("w:color"); col.set(qn("w:val"), color); rPr.append(col)
    r.append(rPr)
    t = OxmlElement("w:t"); t.set(qn("xml:space"), "preserve"); t.text = text
    r.append(t)
    h.append(r)
    p._p.append(h)
    return p._p


def _center_table(t, width_dxa="9000"):
    pr = t._tbl.tblPr
    w = _ordered(pr, "w:tblW", _TBLPR_ORDER)
    w.set(qn("w:type"), "dxa"); w.set(qn("w:w"), width_dxa)
    jc = _ordered(pr, "w:jc", _TBLPR_ORDER)
    jc.set(qn("w:val"), "center")
    lay = _ordered(pr, "w:tblLayout", _TBLPR_ORDER)
    lay.set(qn("w:type"), "fixed")
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for row in t.rows:
        trPr = row._tr.get_or_add_trPr()
        for e in trPr.findall(qn("w:jc")):
            trPr.remove(e)
        rjc = OxmlElement("w:jc"); rjc.set(qn("w:val"), "center"); trPr.append(rjc)


def post_process(out: Path, title: str, meta: list[tuple[str, str]]):
    accent = RGBColor.from_string(ACCENT)
    title_color = RGBColor.from_string(TITLE_COLOR)
    WHITE, GREY = RGBColor(0xFF, 0xFF, 0xFF), RGBColor(0x59, 0x59, 0x59)
    doc = Document(out)

    # 1. A4 portrait (reference docs often inherit Letter/landscape)
    for s in doc.sections:
        s.orientation = WD_ORIENT.PORTRAIT
        s.page_width, s.page_height = Mm(210), Mm(297)
        s.left_margin = s.right_margin = Mm(25)
        s.top_margin, s.bottom_margin = Mm(22), Mm(20)

    # 2. style every markdown table (pandoc's inherited Table style is borderless)
    for t in doc.tables:
        _set_borders(t)
        _full_width(t)
        for c in t.rows[0].cells:
            _shade(c, ACCENT)
            _style_runs(c, bold=True, color=WHITE, size=10.5)
        for i, row in enumerate(t.rows[1:]):
            if i % 2 == 1:
                for c in row.cells:
                    _shade(c, BAND)
            for c in row.cells:
                _style_runs(c, size=10.5)
                for p in c.paragraphs:
                    p.alignment = AL.LEFT

    # 3. heading spacing (on styles) + justified body
    spacing = {"Heading 1": (26, 12), "Heading 2": (20, 9),
               "Heading 3": (15, 7), "Heading 4": (12, 6), "Title": (0, 18)}
    for st in doc.styles:
        if st.name in spacing:
            sb, sa = spacing[st.name]
            st.paragraph_format.space_before = Pt(sb)
            st.paragraph_format.space_after = Pt(sa)
            st.paragraph_format.keep_with_next = True
    nf = doc.styles["Normal"].paragraph_format
    nf.alignment = AL.JUSTIFY
    nf.space_after = Pt(6)
    nf.line_spacing = 1.08

    # 3b. collect H1/H2 headings and bookmark them so the static TOC can link in
    toc_heads = []  # (level, text, anchor)
    for i, p in enumerate(doc.paragraphs):
        if p.style.name in ("Heading 1", "Heading 2") and p.text.strip():
            anchor_name = f"_tocb{i}"
            _add_bookmark(p, anchor_name, 9000 + i)
            toc_heads.append((1 if p.style.name == "Heading 1" else 2, p.text.strip(), anchor_name))

    # 4. cover page (text + metadata derived from the report's Document Control)
    mlower = {k.lower(): (k, v) for k, v in meta}
    classification = mlower.get("classification", ("", "CONFIDENTIAL"))[1]
    target = mlower.get("target", ("", ""))[1]

    # curate cover rows: preferred fields, present + meaningful, no dupes
    cover_rows = []
    seen = set()
    for f in COVER_FIELDS:
        hit = mlower.get(f.lower())
        if not hit:
            continue
        k, v = hit
        if not v or v.strip().upper() in ("TBD", "N/A", "NA", "-") or k.lower() in seen:
            continue
        seen.add(k.lower())
        cover_rows.append((k, v))

    body = doc.element.body
    anchor = body[0]
    created = []

    def para(text="", *, size=None, bold=False, color=None, sb=0, sa=0):
        p = doc.add_paragraph()
        p.alignment = AL.CENTER
        p.paragraph_format.space_before = Pt(sb)
        p.paragraph_format.space_after = Pt(sa)
        if text:
            r = p.add_run(text)
            if size:
                r.font.size = Pt(size)
            r.font.bold = bold
            if color is not None:
                r.font.color.rgb = color
        created.append(p._p)

    para(sb=96)
    para((classification or "CONFIDENTIAL").upper(), size=11, bold=True, color=GREY, sa=10)
    para((title or "Security Assessment Report").upper(), size=28, bold=True, color=title_color, sa=6)
    if target:
        para(target, size=14, color=GREY, sa=30)
    else:
        para(sa=26)

    if cover_rows:
        ct = doc.add_table(rows=len(cover_rows), cols=2)
        _set_borders(ct)
        for i, (k, v) in enumerate(cover_rows):
            row = ct.rows[i]
            row.height = Pt(22)
            row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
            c0, c1 = row.cells
            c0.width, c1.width = Inches(2.3), Inches(3.7)
            _vcenter(c0); _vcenter(c1)
            _cell_pad(c0); _cell_pad(c1)
            # cover table: no cell fill, default (black) text — labels just bold
            r0 = c0.paragraphs[0].add_run(k)
            r0.font.bold = True
            r0.font.size = Pt(10.5)
            r1 = c1.paragraphs[0].add_run(v)
            r1.font.size = Pt(10.5)
        _center_table(ct)
        created.append(ct._tbl)

    pb = doc.add_paragraph()
    pb.add_run().add_break(WD_BREAK.PAGE)
    created.append(pb._p)

    # static, hyperlinked Table of Contents on its own page (page 2)
    if toc_heads:
        th = doc.add_paragraph()
        th.alignment = AL.LEFT
        th.paragraph_format.space_after = Pt(12)
        rr = th.add_run("Table of Contents")
        rr.font.size = Pt(18)
        rr.font.bold = True
        rr.font.color.rgb = title_color
        created.append(th._p)
        for level, text, anchor_name in toc_heads:
            created.append(_toc_entry(doc, text, anchor_name, level, ACCENT))
        tpb = doc.add_paragraph()
        tpb.add_run().add_break(WD_BREAK.PAGE)
        created.append(tpb._p)

    for el in created:
        anchor.addprevious(el)

    doc.save(out)


def to_pdf(docx_path: Path):
    soffice = shutil.which("soffice")
    if not soffice:
        mac = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
        soffice = str(mac) if mac.exists() else None
    if not soffice:
        print("PDF skipped: LibreOffice not found. Open the .docx in Word and 'Save As PDF',\n"
              "  or `brew install --cask libreoffice` and re-run.", file=sys.stderr)
        return None
    subprocess.run([soffice, "--headless", "--convert-to", "pdf",
                    "--outdir", str(docx_path.parent), str(docx_path)], check=True)
    return docx_path.with_suffix(".pdf")


def main():
    args = [a for a in sys.argv[1:] if a not in ("-h", "--help")]
    if len(sys.argv) == 1 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)
    md = Path(args[0])
    if not md.exists():
        sys.exit(f"not found: {md}")

    md_text = md.read_text(encoding="utf-8")
    title, meta = parse_document_control(md_text)

    # output name = "<workflow>_final_report.docx" beside the input.
    # workflow = the run dir (audit-logs/<workflow>/deliverables/final_report.md).
    if md.parent.name == "deliverables":
        workflow = md.parent.parent.name
    else:
        workflow = md.stem
    out = md.parent / f"{workflow}_final_report.docx"

    template = Path(__file__).resolve().parent / TEMPLATE_NAME
    # No --toc: pandoc's TOC is an empty field that LibreOffice won't populate on
    # headless PDF export. We build a static hyperlinked TOC in post_process instead.
    cmd = ["pandoc", str(md), "-f", "gfm", "-o", str(out)]
    if template.exists():
        cmd.append(f"--reference-doc={template}")
    subprocess.run(cmd, check=True)

    post_process(out, title, meta)
    print(f"DOCX: {out}")
    pdf = to_pdf(out)
    if pdf:
        print(f"PDF:  {pdf}")


if __name__ == "__main__":
    main()
