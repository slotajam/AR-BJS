"""Parsers for DOI lists, BibTeX, RIS and CSV into NormalizedRecords."""

import csv
import io
import re

from app.services.normalize import AuthorRec, NormalizedRecord, normalize_doi, strip_markup, year_from_date

MAX_IMPORT_RECORDS = 5000


class ImportFormatError(ValueError):
    pass


def parse_doi_list(text: str) -> list[str]:
    dois, seen = [], set()
    for line in re.split(r"[\s,;]+", text):
        d = normalize_doi(line)
        if d and d not in seen:
            seen.add(d)
            dois.append(d)
    return dois


# ------------------------------------------------------------------ BibTeX

def _read_braced(s: str, i: int) -> tuple[str, int]:
    depth, start = 0, i
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[start + 1:i], i + 1
        i += 1
    raise ImportFormatError("unbalanced braces in BibTeX")


def _bib_value(s: str, i: int) -> tuple[str, int]:
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s):
        return "", i
    if s[i] == "{":
        return _read_braced(s, i)
    if s[i] == '"':
        j = i + 1
        depth = 0
        while j < len(s):
            if s[j] == "{":
                depth += 1
            elif s[j] == "}":
                depth -= 1
            elif s[j] == '"' and depth == 0:
                return s[i + 1:j], j + 1
            j += 1
        raise ImportFormatError("unterminated quoted value in BibTeX")
    m = re.match(r"[\w\-.:]+", s[i:])
    if not m:
        return "", i
    return m.group(0), i + m.end()


def _clean_tex(v: str) -> str:
    v = re.sub(r"\\[a-zA-Z]+\s*\{([^{}]*)\}", r"\1", v)
    v = v.replace("{", "").replace("}", "").replace("\\&", "&").replace("~", " ")
    v = re.sub(r"\\['\"`^~=.]", "", v)
    return re.sub(r"\s+", " ", v).strip()


def parse_bibtex(text: str) -> list[dict]:
    entries = []
    for m in re.finditer(r"@(\w+)\s*\{", text):
        etype = m.group(1).lower()
        if etype in ("comment", "preamble", "string"):
            continue
        body, _ = _read_braced(text, m.end() - 1)
        key, _, rest = body.partition(",")
        fields: dict[str, str] = {"ENTRYTYPE": etype, "ID": key.strip()}
        i = 0
        while i < len(rest):
            fm = re.compile(r"\s*([\w\-]+)\s*=\s*").match(rest, i)
            if not fm:
                i += 1
                continue
            name = fm.group(1).lower()
            val, i = _bib_value(rest, fm.end())
            fields[name] = _clean_tex(val)
            while i < len(rest) and rest[i] in " \t\r\n,":
                i += 1
        entries.append(fields)
    return entries


BIB_TYPE = {"article": "article", "inproceedings": "proceedings", "conference": "proceedings",
            "incollection": "book-chapter", "inbook": "book-chapter", "book": "book", "phdthesis": "dissertation",
            "mastersthesis": "dissertation", "misc": None, "techreport": "report", "unpublished": "preprint"}


def bibtex_records(text: str) -> list[NormalizedRecord]:
    out = []
    for e in parse_bibtex(text)[:MAX_IMPORT_RECORDS]:
        rec = NormalizedRecord(source="import:bibtex", source_record_id=e.get("ID") or None, raw=e)
        rec.doi = normalize_doi(e.get("doi"))
        if rec.doi:
            rec.identifiers["doi"] = rec.doi
        if e.get("eprint") and (e.get("archiveprefix", "").lower() == "arxiv"):
            rec.identifiers["arxiv"] = e["eprint"]
        rec.title = e.get("title") or None
        rec.abstract = e.get("abstract") or None
        names = re.split(r"\s+and\s+", e.get("author", ""))
        rec.authors = [AuthorRec(display_name=a.strip()) for a in names if a.strip()]
        rec.venue = e.get("journal") or e.get("booktitle") or None
        y = e.get("year", "")
        rec.publication_year = int(y[:4]) if re.match(r"^\d{4}", y) else None
        rec.document_type = BIB_TYPE.get(e["ENTRYTYPE"])
        rec.keywords = [k.strip() for k in re.split(r"[;,]", e.get("keywords", "")) if k.strip()]
        out.append(rec.finalize("not_in_import_file"))
    return out


# ------------------------------------------------------------------ RIS

RIS_TYPE = {"JOUR": "article", "CONF": "proceedings", "CPAPER": "proceedings", "CHAP": "book-chapter",
            "BOOK": "book", "THES": "dissertation", "RPRT": "report", "DATA": "dataset", "UNPB": "preprint"}


def parse_ris(text: str) -> list[dict]:
    entries, cur = [], None
    for line in text.splitlines():
        m = re.match(r"^([A-Z][A-Z0-9])  - ?(.*)$", line.rstrip())
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "TY":
            cur = {"TY": [val]}
        elif tag == "ER":
            if cur is not None:
                entries.append(cur)
            cur = None
        elif cur is not None:
            cur.setdefault(tag, []).append(val)
    if cur:
        entries.append(cur)
    return entries


def _first(entry: dict, *tags: str) -> str | None:
    return next((entry[t][0] for t in tags if entry.get(t)), None)


def ris_records(text: str) -> list[NormalizedRecord]:
    out = []
    for e in parse_ris(text)[:MAX_IMPORT_RECORDS]:
        def g(*tags, _e=e):
            return _first(_e, *tags)
        rec = NormalizedRecord(source="import:ris", source_record_id=g("ID"), raw=e)
        rec.doi = normalize_doi(g("DO"))
        if rec.doi:
            rec.identifiers["doi"] = rec.doi
        rec.title = g("TI", "T1")
        rec.abstract = g("AB", "N2")
        rec.authors = [AuthorRec(display_name=a) for a in (e.get("AU", []) + e.get("A1", []))]
        rec.venue = g("JO", "T2", "JF", "JA")
        date = g("PY", "Y1", "DA")
        rec.publication_year = year_from_date(date)
        rec.document_type = RIS_TYPE.get(g("TY") or "")
        rec.keywords = e.get("KW", [])
        rec.language = g("LA")
        out.append(rec.finalize("not_in_import_file"))
    return out


# ------------------------------------------------------------------ CSV

CSV_ALIASES = {
    "doi": ("doi",), "title": ("title",), "abstract": ("abstract",),
    "authors": ("authors", "author"), "venue": ("venue", "journal", "source title", "container_title"),
    "year": ("year", "publication_year"), "document_type": ("document_type", "type"),
    "keywords": ("keywords",),
}


def csv_records(text: str) -> list[NormalizedRecord]:
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not reader.fieldnames:
        raise ImportFormatError("CSV has no header row")
    cols = {f.strip().lower(): f for f in reader.fieldnames}

    def col(row, key):
        for alias in CSV_ALIASES[key]:
            if alias in cols and (row.get(cols[alias]) or "").strip():
                return row[cols[alias]].strip()
        return None

    if not any(a in cols for k in ("doi", "title") for a in CSV_ALIASES[k]):
        raise ImportFormatError("CSV needs at least a 'doi' or 'title' column")
    out = []
    for i, row in enumerate(reader):
        if i >= MAX_IMPORT_RECORDS:
            break
        rec = NormalizedRecord(source="import:csv", source_record_id=f"row:{i + 2}", raw=dict(row))
        rec.doi = normalize_doi(col(row, "doi"))
        if rec.doi:
            rec.identifiers["doi"] = rec.doi
        rec.title = strip_markup(col(row, "title"))
        rec.abstract = col(row, "abstract")
        authors = col(row, "authors") or ""
        rec.authors = [AuthorRec(display_name=a.strip()) for a in re.split(r";|\s+and\s+", authors) if a.strip()]
        rec.venue = col(row, "venue")
        rec.publication_year = year_from_date(col(row, "year"))
        rec.document_type = col(row, "document_type")
        rec.keywords = [k.strip() for k in re.split(r"[;,]", col(row, "keywords") or "") if k.strip()]
        if rec.doi or rec.title:
            out.append(rec.finalize("not_in_import_file"))
    return out


def parse_import(fmt: str, text: str) -> list[NormalizedRecord]:
    if fmt == "bibtex":
        return bibtex_records(text)
    if fmt == "ris":
        return ris_records(text)
    if fmt == "csv":
        return csv_records(text)
    raise ImportFormatError(f"unsupported import format {fmt!r}")
