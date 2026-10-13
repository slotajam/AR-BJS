"""PDF validation: signature, size, HTML-disguised-as-PDF, readability, page count, checksum."""

import hashlib
import re
from dataclasses import dataclass, field

import pymupdf

HTML_SNIFF = re.compile(rb"^\s*(<!doctype\s+html|<html|<head|<body|<\?xml|<script)", re.IGNORECASE)


@dataclass
class Validation:
    ok: bool
    sha256: str
    size_bytes: int
    page_count: int | None = None
    error: str | None = None
    checks: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "error": self.error, "checks": self.checks, "page_count": self.page_count}


def validate_pdf(data: bytes, *, max_bytes: int, declared_content_type: str | None = None) -> Validation:
    sha = hashlib.sha256(data).hexdigest()
    v = Validation(ok=False, sha256=sha, size_bytes=len(data))
    head = data[:1024]
    v.checks["size_within_limit"] = 0 < len(data) <= max_bytes
    if not v.checks["size_within_limit"]:
        v.error = "empty file" if not data else f"file exceeds {max_bytes} bytes"
        return v
    v.checks["not_html"] = not HTML_SNIFF.search(head)
    if not v.checks["not_html"]:
        v.error = "HTML content disguised as PDF"
        return v
    # PDF spec allows the header within the first 1024 bytes.
    v.checks["pdf_signature"] = b"%PDF-" in head
    if not v.checks["pdf_signature"]:
        v.error = "missing %PDF- signature"
        return v
    if declared_content_type:
        v.checks["declared_content_type"] = declared_content_type.split(";")[0].strip().lower()
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as e:  # noqa: BLE001 - any parser failure means unreadable
        v.error = f"unreadable PDF: {e}"
        v.checks["readable"] = False
        return v
    try:
        v.checks["encrypted"] = bool(doc.needs_pass)
        if doc.needs_pass:
            v.error = "password-protected PDF"
            return v
        v.page_count = doc.page_count
        v.checks["readable"] = True
        v.checks["has_pages"] = doc.page_count > 0
        if doc.page_count == 0:
            v.error = "PDF has no pages"
            return v
        try:
            doc.load_page(0).get_text("text")
        except Exception as e:  # noqa: BLE001
            v.error = f"first page unreadable: {e}"
            return v
    finally:
        doc.close()
    v.ok = True
    return v
