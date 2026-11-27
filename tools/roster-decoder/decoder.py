"""Decode bounded roster inputs in a disposable Linux process.

Every supported frame, page, or cell is decoded. Rejections expose only a
fixed error code and omit source content and parser details.
"""
from __future__ import annotations

import base64
from contextlib import closing
import ctypes
import errno
import hashlib
import io
import json
import math
import platform
import re
import resource
import sys
import warnings
import zipfile
import zlib

POLICY = "collect-roster-decoder-v1"
MAX_REQUEST = 8 * 1024 * 1024
MAX_INPUT = 5 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 16_000
MAX_FRAMES = 20
MAX_PAGES = 20
MAX_EXPANDED = 32 * 1024 * 1024
MAX_PDF_OBJECTS = 5_000
MAX_PDF_STREAMS = 2_000
MAX_PDF_DEPTH = 40
MAX_PDF_VISITS = 100_000
PDF_RENDER_SCALE = 4 / 3

MAX_WORKBOOK_ENTRIES = 64
MAX_WORKBOOK_ENTRY_BYTES = 2 * 1024 * 1024
MAX_WORKBOOK_BYTES = 8 * 1024 * 1024
MAX_WORKBOOK_ELEMENTS = 100_000
MAX_WORKBOOK_CELLS = 16_320
MAX_WORKBOOK_SHEETS = 10
MAX_WORKBOOK_ROWS = 500
MAX_WORKBOOK_GRID_ROWS = MAX_WORKBOOK_ROWS + 1
MAX_WORKBOOK_COLUMNS = 32
MAX_CELL_LENGTH = 480
MAX_TSV_BYTES = 512_000

TOOLCHAIN = {
    "python": "3.12", "pillow": "13.0.0", "pypdfium2": "5.2.0",
    "pypdf": "7.2.0", "openpyxl": "3.1.5", "defusedxml": "0.7.1",
}
IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
ALIASES = {
    "member_name": {"member", "member name", "display name", "name"},
    "momo_name": {"momo name", "registered momo name", "registered name", "account name"},
    "momo_number": {"momo number", "mobile money number", "mobile number", "phone", "phone number", "telephone"},
}
ZIP_NAME_CHARACTERS = re.compile(r"[\\\x00-\x20\x7f:%?#]")
XLSX_RELATIONSHIP_TARGET_CHARACTERS = re.compile(r"[:\\\x00-\x20]")
XLSX_CELL_ADDRESS = re.compile(r"([A-Z]{1,2})([1-9][0-9]{0,2})")

# Audit architecture and denied socket, process creation, execution and tracing
# calls for each supported Linux syscall ABI.
SECCOMP_ABIS = {
    "x86_64": (0xc000003e, (41, 42, 43, 49, 50, 53, 56, 57, 58, 59, 101, 288, 322, 435)),
    "aarch64": (0xc00000b7, (198, 199, 200, 201, 202, 203, 220, 221, 117, 242, 281, 435)),
}
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
SECCOMP_KILL_PROCESS = 0x80000000
SECCOMP_RETURN_EPERM = 0x00050000 | errno.EPERM
SECCOMP_ALLOW = 0x7fff0000


class Rejected(Exception):
    pass


class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32),
    ]


class SockFilterProgram(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(SockFilter))]


def reject(code="roster_invalid_file"):
    raise Rejected(code)


def _seccomp_operations(machine):
    abi = SECCOMP_ABIS.get(machine)
    if abi is None:
        reject("roster_decoder_sandbox_unavailable")
    architecture, denied_syscalls = abi

    # Load and verify the audit architecture before loading the syscall number.
    operations = [
        (0x20, 0, 0, 4), (0x15, 1, 0, architecture),
        (0x06, 0, 0, SECCOMP_KILL_PROCESS), (0x20, 0, 0, 0),
    ]
    for number in denied_syscalls:
        operations.extend([(0x15, 0, 1, number), (0x06, 0, 0, SECCOMP_RETURN_EPERM)])
    if machine == "x86_64":
        # Reject the x32 syscall ABI, which shares the x86_64 audit identifier.
        operations.extend([(0x35, 0, 1, 0x40000000), (0x06, 0, 0, SECCOMP_KILL_PROCESS)])
    operations.append((0x06, 0, 0, SECCOMP_ALLOW))
    return operations


def isolate():
    if sys.platform != "linux":
        reject("roster_decoder_sandbox_unavailable")
    limits = (
        (resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2),
        (resource.RLIMIT_CPU, (4, 5)),
        (resource.RLIMIT_FSIZE, (0, 0)),
        (resource.RLIMIT_CORE, (0, 0)),
        (resource.RLIMIT_NOFILE, (32, 32)),
    )
    for limit, bounds in limits:
        resource.setrlimit(limit, bounds)

    operations = _seccomp_operations(platform.machine())
    filters = (SockFilter * len(operations))(*(SockFilter(*op) for op in operations))
    program = SockFilterProgram(len(filters), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if (
        libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        or libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(program), 0, 0) != 0
    ):
        reject("roster_decoder_sandbox_unavailable")


def dimensions(width, height):
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 < v <= MAX_SIDE
               for v in (width, height)) or width * height > MAX_PIXELS:
        reject("roster_image_dimensions_exceeded")


def image(source, mime):
    from PIL import Image, ImageFile

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    ImageFile.LOAD_TRUNCATED_IMAGES = False
    formats = [IMAGE_FORMATS[mime]]
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        # verify() checks format structure. load() independently decodes each frame.
        with Image.open(io.BytesIO(source), formats=formats) as check:
            dimensions(*check.size)
            check.verify()
        with Image.open(io.BytesIO(source), formats=formats) as decoded:
            frames = getattr(decoded, "n_frames", 1)
            if not 1 <= frames <= MAX_FRAMES:
                reject("roster_animation_limit")
            pixels = 0
            for index in range(frames):
                decoded.seek(index)
                dimensions(*decoded.size)
                frame_pixels = decoded.width * decoded.height
                pixels += frame_pixels
                if pixels > MAX_PIXELS:
                    reject("roster_animation_limit")
                decoded.load()
                with closing(decoded.convert("RGBA")) as rgba:
                    if len(rgba.tobytes()) != frame_pixels * 4:
                        reject()
    return {"frames": frames, "pages": 0, "pixels": pixels,
            "expanded_bytes": pixels * 4, "derived_content": None}


def _pdf_stream_size(stream, remaining):
    filters = stream.get("/Filter")
    if filters in ("/FlateDecode", "/Fl"):
        # Bound inflation before passing this stream to pypdf.
        inflater = zlib.decompressobj()
        size = len(inflater.decompress(stream._data, remaining + 1))
        if inflater.unconsumed_tail or not inflater.eof:
            reject("roster_pdf_expansion_limit")
    elif filters in ("/DCTDecode", "/JPXDecode", "/JBIG2Decode", "/CCITTFaxDecode"):
        # PDFium validates compressed images while it renders complete pages.
        return 0
    else:
        # Other filters and filter arrays decode inside the process limits.
        size = len(stream.get_data())
    if size > remaining:
        reject("roster_pdf_expansion_limit")
    return size


def _inspect_pdf_objects(reader):
    from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, StreamObject

    visited = set()
    streams, expanded, events = 0, 0, 0

    def inspect(value, depth=0):
        nonlocal streams, expanded, events
        events += 1
        if depth > MAX_PDF_DEPTH or events > MAX_PDF_VISITS:
            reject("roster_pdf_object_limit")
        if isinstance(value, IndirectObject):
            key = (value.idnum, value.generation)
            if key in visited:
                return
            visited.add(key)
            value = value.get_object()
        if isinstance(value, DictionaryObject):
            if any(k in value for k in ("/JavaScript", "/JS", "/EmbeddedFiles", "/Launch", "/AA")):
                reject("roster_pdf_active_content")
            if value.get("/S") in ("/JavaScript", "/Launch", "/SubmitForm", "/ImportData"):
                reject("roster_pdf_active_content")
            if isinstance(value, StreamObject):
                streams += 1
                if streams > MAX_PDF_STREAMS:
                    reject("roster_pdf_object_limit")
                expanded += _pdf_stream_size(value, MAX_EXPANDED - expanded)
            for key, item in value.items():
                if key != "/Parent":
                    inspect(item, depth + 1)
        elif isinstance(value, ArrayObject):
            for item in value:
                inspect(item, depth + 1)

    # Inspect unreferenced objects as well as objects in compressed streams.
    for generation, entries in reader.xref.items():
        for number in entries:
            if number:
                inspect(IndirectObject(number, generation, reader))
    for number in reader.xref_objStm:
        inspect(IndirectObject(number, 0, reader))
    return expanded


def pdf(source):
    from pypdf import PdfReader
    import pypdfium2 as pdfium

    with io.BytesIO(source) as input_stream, closing(PdfReader(input_stream, strict=True)) as reader:
        if reader.is_encrypted:
            reject("roster_pdf_encrypted")
        objects = sum(len(items) for items in reader.xref.values()) + len(reader.xref_objStm)
        if objects > MAX_PDF_OBJECTS:
            reject("roster_pdf_object_limit")
        pages = len(reader.pages)
        if not 1 <= pages <= MAX_PAGES:
            reject("roster_pdf_page_limit")
        expanded = _inspect_pdf_objects(reader)

    pixels = 0
    with pdfium.PdfDocument(source) as document:
        if len(document) != pages:
            reject()
        for source_page in document:
            with closing(source_page) as page:
                width, height = page.get_size()
                dimensions(width, height)
                pixels += math.ceil(width * 4 / 3) * math.ceil(height * 4 / 3)
                if pixels > MAX_PIXELS:
                    reject("roster_pdf_pixel_limit")
                # Decode the entire page, including fonts and compressed images.
                with closing(page.render(scale=PDF_RENDER_SCALE)) as bitmap:
                    with closing(bitmap.to_pil()) as rendered:
                        rendered.load()
                        rendered.tobytes()
    return {"frames": 0, "pages": pages, "pixels": pixels,
            "expanded_bytes": expanded, "derived_content": None}


def _validate_cell_address(address):
    match = XLSX_CELL_ADDRESS.fullmatch(address)
    if not match or int(match[2]) > MAX_WORKBOOK_GRID_ROWS:
        reject("roster_xlsx_expansion_limit")
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - 64
    if column > MAX_WORKBOOK_COLUMNS:
        reject("roster_xlsx_expansion_limit")


def _validate_workbook_xml(content, elements, cells):
    from defusedxml.ElementTree import fromstring

    document = fromstring(content, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    for element in document.iter():
        elements += 1
        if elements > MAX_WORKBOOK_ELEMENTS:
            reject("roster_xlsx_expansion_limit")
        name = element.tag.rsplit("}", 1)[-1]
        if name in ("f", "definedName", "externalLink", "oleObject", "vbaProject"):
            reject("roster_xlsx_formula")
        if name == "Relationship":
            target = element.attrib.get("Target", "")
            if element.attrib.get("TargetMode") == "External" or XLSX_RELATIONSHIP_TARGET_CHARACTERS.search(target):
                reject("roster_xlsx_external_reference")
        elif name == "c":
            if element.attrib.get("t") in ("str", "e"):
                reject("roster_xlsx_formula")
            cells += 1
            if cells > MAX_WORKBOOK_CELLS:
                reject("roster_xlsx_expansion_limit")
            _validate_cell_address(element.attrib.get("r", ""))
        elif name == "row":
            row = element.attrib.get("r", "")
            if not row.isdigit() or not 1 <= int(row) <= MAX_WORKBOOK_GRID_ROWS:
                reject("roster_xlsx_expansion_limit")
    return elements, cells


def _validate_workbook_entry(entry, names, expanded):
    name = entry.filename
    if (
        name in names or len(name) > 240 or ZIP_NAME_CHARACTERS.search(name)
        or name.startswith("/") or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
    ):
        reject()
    names.add(name)
    mode = (entry.external_attr >> 16) & 0xf000
    if entry.flag_bits & ~0x080e or entry.compress_type not in (0, 8) or mode not in (0, 0x8000, 0x4000):
        reject()
    expanded += entry.file_size
    if (
        entry.file_size > MAX_WORKBOOK_ENTRY_BYTES or expanded > MAX_WORKBOOK_BYTES
        or entry.file_size > entry.compress_size * 200 + 4096
    ):
        reject("roster_xlsx_expansion_limit")
    return expanded


def _copy_validated_workbook(source, destination):
    expanded, elements, cells = 0, 0, 0
    names = set()
    with (
        io.BytesIO(source) as input_stream,
        zipfile.ZipFile(input_stream) as archive,
        zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as trusted,
    ):
        entries = archive.infolist()
        if not 1 <= len(entries) <= MAX_WORKBOOK_ENTRIES:
            reject("roster_xlsx_expansion_limit")
        for entry in entries:
            expanded = _validate_workbook_entry(entry, names, expanded)
            # Check the read length and let ZipExtFile verify the CRC.
            with archive.open(entry) as stream:
                content = stream.read(entry.file_size + 1)
                if len(content) != entry.file_size or stream.read(1):
                    reject()
            if entry.filename.endswith((".xml", ".rels")):
                elements, cells = _validate_workbook_xml(content, elements, cells)
            elif not entry.is_dir():
                reject("roster_xlsx_active_content")
            trusted.writestr(entry.filename, content)
    return expanded


def _workbook_cell_text(cell):
    value = cell.value
    if cell.data_type in ("f", "e") or isinstance(value, bool):
        reject("roster_xlsx_formula")
    if value is None:
        text = ""
    elif isinstance(value, float):
        if not math.isfinite(value):
            reject()
        text = str(int(value)) if value.is_integer() else str(value)
    elif isinstance(value, (str, int)):
        text = str(value).strip()
    else:
        reject("roster_xlsx_cell_type")
    if len(text) > MAX_CELL_LENGTH or "\x00" in text:
        reject("roster_xlsx_expansion_limit")
    return text


def _workbook_columns(first_row):
    indices = dict.fromkeys(ALIASES, -1)
    for index, value in enumerate(first_row):
        key = re.sub(r"[\s_-]+", " ", value.lower()).strip()
        for field, aliases in ALIASES.items():
            if key in aliases:
                indices[field] = index
    header = any(index >= 0 for index in indices.values())
    if not header:
        return False, dict(zip(ALIASES, (0, 1, 2)))
    if indices["momo_number"] < 0:
        reject("roster_xlsx_header")
    return True, indices


def _roster_cell(row, index):
    return re.sub(r"[\t\r\n]+", " ", row[index]).strip() if 0 <= index < len(row) else ""


def _workbook_tsv(book):
    if not 1 <= len(book.worksheets) <= MAX_WORKBOOK_SHEETS:
        reject("roster_xlsx_expansion_limit")
    output = ["Member name\tMoMo name\tMoMo number"]
    for sheet in book.worksheets:
        if sheet.max_row > MAX_WORKBOOK_GRID_ROWS or sheet.max_column > MAX_WORKBOOK_COLUMNS:
            reject("roster_xlsx_expansion_limit")
        rows = []
        for row in sheet.iter_rows():
            values = [_workbook_cell_text(cell) for cell in row]
            if any(values):
                rows.append(values)
        if not rows:
            continue

        header, indices = _workbook_columns(rows[0])
        for row in rows[1:] if header else rows:
            member = _roster_cell(row, indices["member_name"])
            momo = _roster_cell(row, indices["momo_name"])
            number = _roster_cell(row, indices["momo_number"])
            output.append("\t".join((member or momo, momo, number)))
            if len(output) > MAX_WORKBOOK_ROWS + 1:
                reject("roster_xlsx_expansion_limit")
    if len(output) == 1:
        reject("roster_xlsx_empty")
    content = "\n".join(output)
    if len(content.encode()) > MAX_TSV_BYTES:
        reject("roster_xlsx_expansion_limit")
    return content


def workbook(source):
    from openpyxl import load_workbook

    with io.BytesIO() as canonical:
        expanded = _copy_validated_workbook(source, canonical)
        canonical.seek(0)
        with closing(load_workbook(canonical, read_only=True, data_only=False, keep_links=False)) as book:
            content = _workbook_tsv(book)
    return {"frames": 0, "pages": 0, "pixels": 0, "expanded_bytes": expanded,
            "derived_content": content}


def decode(request):
    source = base64.b64decode(request["content_base64"], validate=True)
    if not 1 <= len(source) <= MAX_INPUT or hashlib.sha256(source).hexdigest() != request["source_sha256"]:
        reject("roster_decoder_source_mismatch")
    kind = request["kind"]
    if kind == "image":
        summary = image(source, request["mime"])
    elif kind == "pdf" and request["mime"] == "application/pdf":
        summary = pdf(source)
    elif kind == "xlsx" and request["mime"] == XLSX_MIME:
        summary = workbook(source)
    else:
        reject("roster_type_mismatch")
    content = summary["derived_content"]
    return {"ok": True, "policy_version": POLICY, "toolchain": TOOLCHAIN,
            "source_sha256": request["source_sha256"], "source_size": len(source),
            "derived_sha256": hashlib.sha256(content.encode()).hexdigest() if content is not None else None,
            **summary}


def _read_request(stream):
    body = stream.read(MAX_REQUEST + 1)
    if len(body) > MAX_REQUEST:
        reject()
    return json.loads(body)


def main():
    try:
        isolate()
        result = decode(_read_request(sys.stdin.buffer))
    except Rejected as error:
        result = {"ok": False, "error": str(error)}
    except BaseException:
        result = {"ok": False, "error": "roster_invalid_file"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
