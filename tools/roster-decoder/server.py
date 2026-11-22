"""Serve authenticated decode requests and supervise isolated decoder children."""
from __future__ import annotations

from contextlib import closing
import ctypes
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time

POLICY = "collect-roster-decoder-v1"
BUILD_FILES = {
    "decoder.py": "decoder.py",
    "server.py": "server.py",
    "requirements.lock": "requirements.lock",
    "Dockerfile": "build.Dockerfile",
}
BUILD_HASH = hashlib.sha256(json.dumps({
    name: hashlib.sha256(Path(__file__).with_name(path).read_bytes()).hexdigest()
    for name, path in BUILD_FILES.items()
}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

LIMIT = 8 * 1024 * 1024
INPUT_TIMEOUT = 5
DECODE_TIMEOUT = 8
IO_TIMEOUT = INPUT_TIMEOUT + DECODE_TIMEOUT
DECODE_OUTPUT_LIMIT = 550_000
PIPE_CHUNK_SIZE = 64 * 1024
CONNECTION_LIMIT = 2
FRESHNESS_SECONDS = 30
NONCE_RETENTION_SECONDS = 60
NONCE_LIMIT = 5000
REQUEST_FIELDS = frozenset({
    "request_id", "reservation_id", "source_sha256", "mime", "kind",
    "content_base64", "policy_version", "nonce", "issued_at",
})
REQUEST_TEXT_FIELDS = REQUEST_FIELDS - {"issued_at"}
RESULT_FIELDS = frozenset({
    "ok", "policy_version", "toolchain", "source_sha256", "source_size",
    "derived_sha256", "frames", "pages", "pixels", "expanded_bytes", "derived_content",
})
UUID = re.compile(r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
DECODER_ERROR = re.compile(r"roster_[a-z_]{1,60}")
OVERLOAD_RESPONSE = (
    b"HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
)

SECRET = os.environ.get("ROSTER_DECODER_SECRET", "")
if len(SECRET.encode()) < 32:
    raise SystemExit("ROSTER_DECODER_SECRET must contain at least 32 bytes")
if sys.platform != "linux" or ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
    raise SystemExit("Linux proc credential isolation is required")
DB = os.environ.get("ROSTER_DECODER_NONCE_DB", "/state/nonces.sqlite3")
NONCE_LOCK = threading.Lock()
with sqlite3.connect(DB) as db:
    db.execute("create table if not exists nonces (nonce text primary key, issued_at integer not null)")
db.close()


def signature(value):
    return hmac.new(SECRET.encode(), value, hashlib.sha256).hexdigest()


def compact_json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class ResponseFailure(Exception):
    def __init__(self, code, status):
        super().__init__(code)
        self.code = code
        self.status = status


def request_length(headers):
    lengths = headers.get_all("Content-Length", ())
    if len(lengths) != 1 or headers.get_all("Transfer-Encoding"):
        return None
    value = lengths[0]
    if not value.isascii() or not value.isdecimal():
        return None
    digits = value.lstrip("0")
    if not digits or len(digits) > len(str(LIMIT)):
        return None
    length = int(digits)
    return length if length <= LIMIT else None


def validate_request(request, now):
    if not isinstance(request, dict) or request.keys() != REQUEST_FIELDS:
        raise ResponseFailure("roster_decoder_request_invalid", 400)
    if (
        not all(isinstance(request[key], str) for key in REQUEST_TEXT_FIELDS)
        or request["policy_version"] != POLICY
        or not all(UUID.fullmatch(request[key]) for key in ("request_id", "reservation_id", "nonce"))
        or not SHA.fullmatch(request["source_sha256"])
        or request["kind"] not in ("image", "pdf", "xlsx")
        or type(request["issued_at"]) is not int
        or abs(now - request["issued_at"]) > FRESHNESS_SECONDS
    ):
        raise ResponseFailure("roster_decoder_request_invalid", 400)


def claim_nonce(nonce, issued_at, now):
    with NONCE_LOCK, closing(sqlite3.connect(DB)) as db, db:
        db.execute("delete from nonces where issued_at < ?", (now - NONCE_RETENTION_SECONDS,))
        if db.execute("select count(*) from nonces").fetchone()[0] >= NONCE_LIMIT:
            return ResponseFailure("roster_decoder_limit", 429)
        try:
            db.execute("insert into nonces values (?,?)", (nonce, issued_at))
        except sqlite3.IntegrityError:
            return ResponseFailure("roster_decoder_replay", 409)
    return None


def transfer_decoder_output(process, body):
    """Drive both child pipes under one deadline and one stdout byte limit."""
    deadline = time.monotonic() + DECODE_TIMEOUT
    pending = memoryview(body)
    output = bytearray()
    with selectors.DefaultSelector() as pipes:
        for stream, event in ((process.stdin, selectors.EVENT_WRITE), (process.stdout, selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            pipes.register(stream, event)
        while pipes.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ResponseFailure("roster_decoder_resource_limit", 422)
            for key, event in pipes.select(remaining):
                if event == selectors.EVENT_WRITE:
                    try:
                        written = os.write(key.fd, pending[:PIPE_CHUNK_SIZE])
                    except BlockingIOError:
                        continue
                    except BrokenPipeError:
                        written = len(pending)
                    pending = pending[written:]
                    if not pending:
                        pipes.unregister(process.stdin)
                        process.stdin.close()
                else:
                    available = DECODE_OUTPUT_LIMIT - len(output)
                    try:
                        chunk = os.read(key.fd, min(PIPE_CHUNK_SIZE, available + 1))
                    except BlockingIOError:
                        continue
                    if len(chunk) > available:
                        raise ResponseFailure("roster_decoder_resource_limit", 422)
                    if chunk:
                        output.extend(chunk)
                    else:
                        pipes.unregister(process.stdout)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ResponseFailure("roster_decoder_resource_limit", 422)
    try:
        returncode = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        raise ResponseFailure("roster_decoder_resource_limit", 422) from None
    if returncode:
        raise ResponseFailure("roster_decoder_resource_limit", 422)
    return output


def run_decoder(body):
    command = [sys.executable, "-I", str(Path(__file__).with_name("decoder.py"))]
    # Pass source via stdin and replace the inherited environment.
    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        close_fds=True, bufsize=0, cwd="/tmp",
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    ) as process:
        try:
            output = transfer_decoder_output(process, body)
        finally:
            if process.poll() is None:
                process.kill()
    return json.loads(output)


def signed_result(request, decoded):
    if not isinstance(decoded, dict):
        raise ValueError("decoder result must be an object")
    if decoded.get("ok") is not True:
        code = decoded.get("error")
        if not isinstance(code, str) or not DECODER_ERROR.fullmatch(code):
            code = "roster_invalid_file"
        raise ResponseFailure(code, 422)
    # Only the supervisor sets identifiers in the signed response.
    if (
        decoded.keys() != RESULT_FIELDS
        or decoded["policy_version"] != POLICY
        or decoded["source_sha256"] != request["source_sha256"]
    ):
        raise ValueError("decoder result contract changed")
    payload = compact_json({
        "contract_version": 1,
        "request_id": request["request_id"],
        "reservation_id": request["reservation_id"],
        "nonce": request["nonce"],
        "issued_at": int(time.time()),
        "kind": request["kind"],
        "mime": request["mime"],
        "decoder_build_sha256": BUILD_HASH,
        **decoded,
    })
    return {"payload": payload, "signature": signature(payload.encode())}


class RequestDeadline:
    def __init__(self, connection):
        self.connection = connection
        self.input_lock = threading.Lock()
        self.input_finished = False
        self.input_expired = False
        self.input_deadline = time.monotonic() + INPUT_TIMEOUT
        # Socket timeouts reset on progress, so timers also bound the total I/O.
        self.input_timer = threading.Timer(INPUT_TIMEOUT, self.expire_input)
        self.io_timer = threading.Timer(IO_TIMEOUT, self.expire_connection)
        self.input_timer.daemon = self.io_timer.daemon = True
        self.input_timer.start()
        self.io_timer.start()

    def expire_connection(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def expire_input(self):
        with self.input_lock:
            if self.input_finished:
                return
            self.input_expired = True
        self.expire_connection()

    def finish_input(self):
        with self.input_lock:
            if self.input_expired or time.monotonic() >= self.input_deadline:
                raise TimeoutError("request input deadline exceeded")
            self.input_finished = True
        self.input_timer.cancel()

    def close(self):
        self.input_timer.cancel()
        self.io_timer.cancel()
        self.input_timer.join()
        self.io_timer.join()


class BoundedServer(ThreadingHTTPServer):
    # Shutdown joins active handlers, which in turn reap their decoder children.
    daemon_threads = False
    block_on_close = True
    stopping = False
    request_queue_size = 4
    # Two 384 MiB decoders and a bounded supervisor fit the 896 MiB cap.
    connections = threading.BoundedSemaphore(CONNECTION_LIMIT)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(INPUT_TIMEOUT)
        return request, address

    def verify_request(self, request, address):
        return not self.stopping and super().verify_request(request, address)

    def process_request(self, request, address):
        if self.stopping:
            self.shutdown_request(request)
            return
        if not self.connections.acquire(blocking=False):
            try:
                request.sendall(OVERLOAD_RESPONSE)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()

    def handle_error(self, *_):
        pass  # BaseServer logs client addresses and exception details by default.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(INPUT_TIMEOUT)
        self.deadline = RequestDeadline(self.connection)

    def _finish_input(self):
        self.deadline.finish_input()

    def finish(self):
        try:
            super().finish()
        finally:
            self.deadline.close()

    def log_message(self, *_):
        pass  # Suppress request and parser details.

    def reply(self, value, status=200):
        self.close_connection = True
        data = compact_json(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def decode_request(self):
        length = request_length(self.headers)
        if self.path != "/decode" or length is None:
            raise ResponseFailure("roster_decoder_request_invalid", 400)
        body = self.rfile.read(length)
        self._finish_input()
        auth = self.headers.get_all("Authorization", ())
        if (
            len(body) != length
            or len(auth) != 1
            or not auth[0].isascii()
            or not hmac.compare_digest(auth[0], "Roster-HMAC " + signature(body))
        ):
            raise ResponseFailure("roster_decoder_authentication_required", 401)
        request = json.loads(body)
        validate_request(request, int(time.time()))
        refusal = claim_nonce(request["nonce"], request["issued_at"], int(time.time()))
        if refusal is not None:
            raise refusal
        return signed_result(request, run_decoder(body))

    def do_POST(self):
        try:
            value, status = self.decode_request(), 200
        except ResponseFailure as error:
            value, status = {"error": error.code}, error.status
        except (ConnectionError, TimeoutError):
            self.close_connection = True
            return
        except Exception:
            value, status = {"error": "roster_decoder_unavailable"}, 503
        try:
            self.reply(value, status)
        except OSError:
            self.close_connection = True


def serve_until_signalled(server):
    finished = threading.Event()

    def request_stop(_signum, _frame):
        # Shutdown waits on the serving thread where signal handlers run.
        server.stopping = True

    def stop_serving():
        while not finished.is_set():
            if server.stopping:
                server.shutdown()
                return
            finished.wait(0.05)

    previous = {sig: signal.signal(sig, request_stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    controller = threading.Thread(target=stop_serving, name="decoder-shutdown")
    controller.start()
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        finished.set()
        try:
            server.server_close()
        finally:
            controller.join()
            for sig, handler in previous.items():
                signal.signal(sig, handler)


if __name__ == "__main__":
    serve_until_signalled(BoundedServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler))
