#!/usr/bin/env python3
"""
Stock Tracker - zero-dependency backend.

Serves the PWA (from ./public) and proxies live quotes so the browser can
show them (calling a data provider directly from the page is blocked by CORS,
so the page calls our same-origin /api/quotes endpoint and we fetch server-side).

Data providers, in priority order:
  1. Finnhub  - used when FINNHUB_API_KEY is set. Reliable from cloud/data-center
                IPs (needed for always-on hosting like Render). Free tier.
  2. Yahoo    - no key needed; used as the primary when no Finnhub key is set,
                and as an automatic fallback for symbols Finnhub can't price.

Run:  python3 server.py                    (port 8000, all interfaces)
      PORT=9000 python3 server.py
      FINNHUB_API_KEY=xxxx python3 server.py
"""

import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(HERE, "public")
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "0.0.0.0")

# How long a fetched quote is reused before we hit the source again (seconds).
# Higher values reduce API usage (important for Finnhub's free 60 calls/min).
CACHE_TTL = int(os.environ.get("CACHE_TTL", "12"))

# Finnhub (optional). Key is read from the environment - never hardcoded - so
# it can be stored as a host secret. Empty means "Yahoo only".
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()
FINNHUB_QUOTE = "https://finnhub.io/api/v1/quote"

# query2 is used first because it is far less aggressively rate-limited than
# query1; query1 is kept as a fallback host. The v8 chart endpoint needs no
# API key, cookie, or crumb.
YAHOO_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]
YAHOO_CHART_PATH = "/v8/finance/chart/{symbol}"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
BASE_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
}

_ssl_ctx = ssl.create_default_context()
_cache = {}          # symbol -> (timestamp, quote_dict)   short-lived (CACHE_TTL)
_last_good = {}      # symbol -> quote_dict                 last successful fetch
_cache_lock = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def _cache_get(symbol):
    with _cache_lock:
        cached = _cache.get(symbol)
        if cached and time.time() - cached[0] < CACHE_TTL:
            return cached[1]
    return None


def _cache_put(symbol, result):
    with _cache_lock:
        _cache[symbol] = (time.time(), result)


def _parse_chart(symbol, payload):
    meta = payload["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice")
    if price is None:
        return None
    return {
        "symbol": symbol,
        "price": price,
        "previousClose": meta.get("chartPreviousClose", meta.get("previousClose")),
        "currency": meta.get("currency"),
        "marketTime": meta.get("regularMarketTime"),
        "marketState": meta.get("marketState"),
        "name": meta.get("shortName") or meta.get("longName") or symbol,
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "source": "yahoo",
    }


# Tuning: keep concurrency modest and retry on 429 with backoff. Residential
# IPs rarely hit Yahoo's limits, but this keeps us well-behaved regardless.
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))
MAX_RETRIES = int(os.environ.get("MAX_RETRIES", "3"))


def _fetch_finnhub(symbol):
    """Fetch one quote from Finnhub. Returns a quote dict, or None if the key
    is missing / the symbol is unknown / the request fails."""
    if not FINNHUB_API_KEY:
        return None
    url = FINNHUB_QUOTE + "?" + urllib.parse.urlencode({"symbol": symbol, "token": FINNHUB_API_KEY})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=9, context=_ssl_ctx) as resp:
            d = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - fall back to Yahoo on any failure
        return None
    price = d.get("c")
    # Finnhub returns c==0 for symbols it doesn't cover (OTC, some ADRs, etc.).
    if not price:
        return None
    return {
        "symbol": symbol,
        "price": price,
        "previousClose": d.get("pc"),
        "currency": "USD",
        "marketTime": d.get("t"),
        "marketState": None,
        "name": symbol,
        "exchange": None,
        "source": "finnhub",
    }


def _fetch_yahoo(symbol):
    """Fetch one quote via Yahoo's v8 chart endpoint, trying each host with
    retry + backoff when a host responds 429 (rate limited). Returns a quote
    dict on success, else None."""
    qs = urllib.parse.urlencode({"interval": "1d", "range": "1d"})
    for attempt in range(MAX_RETRIES):
        for host in YAHOO_HOSTS:
            url = "https://" + host + YAHOO_CHART_PATH.format(symbol=urllib.parse.quote(symbol)) + "?" + qs
            try:
                req = urllib.request.Request(url, headers=BASE_HEADERS)
                with urllib.request.urlopen(req, timeout=9, context=_ssl_ctx) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                parsed = _parse_chart(symbol, payload)
                if parsed:
                    return parsed
            except Exception:  # noqa: BLE001 - try next host / retry
                pass
        if attempt < MAX_RETRIES - 1:
            time.sleep(0.6 * (attempt + 1))  # linear backoff between retries
    return None


def fetch_quote(symbol):
    """Fetch one quote, Finnhub first (if configured) then Yahoo fallback.

    On failure we return the last successful quote for this symbol (flagged
    "stale") instead of an error. This keeps every holding continuously priced
    so net worth and the day-change don't jump around just because a provider
    momentarily rate-limited a subset of symbols."""
    cached = _cache_get(symbol)
    if cached is not None:
        return cached

    result = _fetch_finnhub(symbol) or _fetch_yahoo(symbol)
    if result is not None:
        with _cache_lock:
            _last_good[symbol] = result
        _cache_put(symbol, result)
        return result

    # Fetch failed: fall back to the last known-good quote if we have one.
    with _cache_lock:
        prev = _last_good.get(symbol)
    if prev is not None:
        stale = dict(prev)
        stale["stale"] = True
        _cache_put(symbol, stale)
        return stale

    result = {"symbol": symbol, "error": "no data from any provider"}
    _cache_put(symbol, result)
    return result


def fetch_quotes(symbols):
    symbols = [s for s in dict.fromkeys(s.strip().upper() for s in symbols) if s]
    if not symbols:
        return {}
    out = {}
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(symbols))) as pool:
        for res in pool.map(fetch_quote, symbols):
            out[res["symbol"]] = res
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "StockTracker/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            return self._send_json({"ok": True, "time": int(time.time())})

        if path == "/api/quotes":
            params = urllib.parse.parse_qs(parsed.query)
            symbols_raw = params.get("symbols", [""])[0]
            symbols = symbols_raw.split(",") if symbols_raw else []
            quotes = fetch_quotes(symbols)
            return self._send_json({"quotes": quotes, "fetchedAt": int(time.time())})

        return self._serve_static(path)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # prevent directory traversal
        safe = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(PUBLIC_DIR, safe)
        if not full.startswith(PUBLIC_DIR) or not os.path.isfile(full):
            self.send_error(404, "Not found")
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if ext in (".png", ".svg", ".ico"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    provider = "Finnhub (+ Yahoo fallback)" if FINNHUB_API_KEY else "Yahoo Finance"
    print(f"Stock Tracker running:")
    print(f"  Local:    http://localhost:{PORT}")
    print(f"  Network:  http://<your-mac-ip>:{PORT}   (open this on your iPhone)")
    print(f"  Provider: {provider}   |  cache {CACHE_TTL}s")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
