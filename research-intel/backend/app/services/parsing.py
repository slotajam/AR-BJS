"""PyMuPDF text extraction into stable, page-linked chunks.

Chunks never span pages. Each chunk keeps the 0-based page index, the printed
page label (when the PDF defines one), character offsets into that page's
extracted text, block bounding boxes in PDF points, and a heuristic section label.

Not extracted in Phase 1 (reported as unsupported): structured tables,
equations, supplements, reference parsing, OCR of scanned pages.
"""

import re
from dataclasses import dataclass, field

import pymupdf

EXTRACTION_VERSION = "pymupdf-blocks-v1"
TARGET_CHARS = 1200
UNSUPPORTED = ["structured_tables", "equations", "supplements", "references_parsing", "ocr"]

SECTION_RE = re.compile(
    r"^\s*((\d+(\.\d+)*\.?)\s+)?(abstract|introduction|background|related work|methods?|methodology|materials and "
    r"methods|experimental( setup)?|results?|discussion|conclusions?|acknowledg(e)?ments?|references|bibliography|"
    r"appendix)\b",
    re.IGNORECASE,
)


@dataclass
class ChunkData:
    chunk_index: int
    page_index: int
    printed_page: str | None
    section_label: str | None
    text: str
    char_start: int
    char_end: int
    bboxes: list[list[float]] = field(default_factory=list)


@dataclass
class ParseResult:
    chunks: list[ChunkData]
    page_count: int
    pages_without_text: list[int]
    unsupported: list[str]
    extraction_version: str = EXTRACTION_VERSION


def _detect_section(block_text: str) -> str | None:
    first = block_text.strip().split("\n", 1)[0]
    if len(first) > 80:
        return None
    m = SECTION_RE.match(first)
    return first.strip() if m else None


class _PageChunker:
    """Accumulates consecutive blocks of one page into chunks of ~TARGET_CHARS."""

    def __init__(self, out: list[ChunkData], page_index: int, label: str | None):
        self.out, self.page_index, self.label = out, page_index, label
        self.page_text = ""
        self.text, self.start, self.boxes, self.section = "", 0, [], None

    def add(self, text: str, bbox: list[float], section: str | None) -> None:
        if self.page_text:
            self.page_text += "\n"
        start = len(self.page_text)
        self.page_text += text
        if not self.text:
            self.start, self.section = start, section
        else:
            self.text += "\n"
        self.text += text
        self.boxes.append(bbox)
        if len(self.text) >= TARGET_CHARS:
            self.flush()

    def flush(self) -> None:
        if self.text.strip():
            self.out.append(ChunkData(len(self.out), self.page_index, self.label, self.section, self.text,
                                      self.start, self.start + len(self.text), self.boxes))
        self.text, self.boxes = "", []


def parse_pdf(data: bytes) -> ParseResult:
    doc = pymupdf.open(stream=data, filetype="pdf")
    chunks: list[ChunkData] = []
    empty_pages: list[int] = []
    section: str | None = None
    page_count = doc.page_count
    try:
        for pno in range(page_count):
            page = doc.load_page(pno)
            blocks = [b for b in page.get_text("blocks", sort=True) if b[6] == 0 and b[4].strip()]
            if not blocks:
                empty_pages.append(pno)
                continue
            chunker = _PageChunker(chunks, pno, page.get_label() or None)
            for b in blocks:
                text = re.sub(r"[ \t]+", " ", b[4]).strip()
                heading = _detect_section(text)
                if heading:
                    chunker.flush()  # a new section starts a new chunk
                    section = heading
                chunker.add(text, [round(b[0], 2), round(b[1], 2), round(b[2], 2), round(b[3], 2)], section)
            chunker.flush()
    finally:
        doc.close()
    return ParseResult(chunks=chunks, page_count=page_count, pages_without_text=empty_pages,
                       unsupported=list(UNSUPPORTED))
