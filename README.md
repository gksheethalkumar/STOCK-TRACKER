# Net Worth · Stock Tracker

A lightweight, installable iPhone web app (PWA) that tracks your portfolio's
**net worth in real time** using live quotes, and lets you **add or edit any
holding manually** at any time.

- Live prices via Yahoo Finance (no API key, no signup)
- Big net-worth number + today's dollar & percent change
- Per-holding price, day change, value, and portfolio weight
- Add / edit / delete tickers; manual price override for anything that can't be
  priced automatically (CUSIPs, delisted tickers, warrants)
- Works offline (shows last known prices) and installs to your Home Screen
- **Zero dependencies** — pure Python standard library + vanilla JS

Your holdings are stored locally in your browser (`localStorage`). Nothing is
sent anywhere except the ticker symbols, which go to the price provider.

There are two ways to run it:

- **Option A - Always-on in the cloud (recommended):** your iPhone app works
  anywhere with your Mac off. Setup once, then forget it.
- **Option B - Locally on your Mac:** great for trying it out / development;
  your phone reaches it over Wi-Fi while the Mac runs it.

---

## Option A · Always-on in the cloud (no Mac needed)

This hosts the tiny server on **Render** (free) and uses **Finnhub** for prices
(reliable from cloud IPs). Your iPhone home-screen app then works anywhere.

### 1. Get a free Finnhub API key

1. Go to <https://finnhub.io> → **Sign up** (free, no credit card).
2. Copy your **API key** from the dashboard.

### 2. Put this project on GitHub

Your repo: <https://github.com/gksheethalkumar/STOCK-TRACKER>

```bash
cd Stock-Tracker
git init
git add -A
git commit -m "Stock Tracker"
git branch -M main
git remote add origin https://github.com/gksheethalkumar/STOCK-TRACKER.git
git push -u origin main
```

### 3. Deploy on Render

1. Go to <https://render.com> → sign up (you can sign in with GitHub).
2. **New +** → **Blueprint** → select your `STOCK-TRACKER` repo.
   Render reads `render.yaml` automatically.
3. When prompted for env vars, set **`FINNHUB_API_KEY`** to the key from step 1.
   Optionally set **`TWELVEDATA_API_KEY`** (free key from
   <https://twelvedata.com> → Sign up) to enable the **growth chart**. Without
   it, quotes/net worth still work and the chart just shows an "add a key" note.
4. Click **Apply / Create**. After it builds you'll get a public URL like
   `https://stock-tracker-xxxx.onrender.com`.

> Free Render services sleep after ~15 min idle, so the first open of the day
> takes ~30-50s to wake up, then it's fast. That's fine for a personal tracker.

### 4. Install on your iPhone

1. Open the Render URL in **Safari** on your iPhone.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch it from the Home Screen — full-screen, live, and Mac-independent.

---

## Option B · Run locally on your Mac

### Requirements

- macOS with **Python 3** (already installed: `python3 --version`)
- Your iPhone on the **same Wi-Fi** as your Mac

No `pip install`, no Node, no build step.

### Run it

```bash
cd Stock-Tracker
./run.sh
```

You'll see something like:

```
On this Mac:    http://localhost:8000
On your iPhone: http://192.168.1.23:8000
```

### (Local) Put it on your iPhone Home Screen

1. Make sure `./run.sh` is running on your Mac.
2. On your iPhone, open **Safari** and go to the `http://<your-mac-ip>:8000`
   address shown by `run.sh`.
3. Tap the **Share** button → **Add to Home Screen** → **Add**.
4. Open it from the Home Screen — it runs full-screen like a native app.

> The Mac must be running `./run.sh` for live prices to update. The app still
> opens offline and shows the last prices it saw.

## Using the app

- **＋** (top right): add a ticker — enter the symbol and shares. Leave the price
  blank to use the live price, or enter a price and check "Always use my price"
  for things Yahoo can't quote.
- **Tap any row** to edit its shares/price or delete it.
- **⟳**: refresh now. It also auto-refreshes every 20 seconds while open.
- **Reset to portfolio**: restore the original holdings from your Aug 20 summary.

## Verify live quotes are working

```bash
# with the server running:
curl "http://localhost:8000/api/quotes?symbols=AAPL,MSFT,NVDA"
```

You should get JSON with a `price` for each symbol. If you see `HTTP 429`,
Yahoo is briefly rate-limiting your IP — wait a minute and try again, or lower
the refresh pressure with `MAX_WORKERS=2 ./run.sh`.

## Configuration (optional env vars)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FINNHUB_API_KEY` | _(none)_ | If set, use Finnhub for prices (Yahoo fallback). Set this as a secret on Render. |
| `TWELVEDATA_API_KEY` | _(none)_ | If set, enables the portfolio growth chart (historical prices). Free key from twelvedata.com. Set as a secret on Render. |
| `HISTORY_MAX_SYMBOLS` | `6` | How many of your largest holdings to pull history for (kept under the free ≈8 calls/min cap); the rest are extrapolated from that basket. |
| `HISTORY_TTL` | `172800` | Seconds history is cached server-side (app also caches on-device 2 days → refetches are rare). |
| `PORT` | `8000` | Port to serve on (Render sets this automatically) |
| `HOST` | `0.0.0.0` | Bind address (all interfaces, so the iPhone can reach it) |
| `CACHE_TTL` | `12` | Seconds a quote is reused before refetching (Render uses `30`) |
| `MAX_WORKERS` | `4` | Concurrent quote fetches |
| `MAX_RETRIES` | `3` | Yahoo retries per symbol on rate-limit |

## How live prices work (and the CORS note)

Browsers can't call price APIs directly (CORS + rate limiting). So the tiny
Python server (`server.py`) fetches quotes server-side and exposes them to the
app at `/api/quotes`. It uses **Finnhub** when `FINNHUB_API_KEY` is set (best for
cloud hosting), and **Yahoo Finance** (`query2.finance.yahoo.com`) with no key
otherwise and as an automatic per-symbol fallback. Results are cached briefly
(`CACHE_TTL`) so rapid refreshes don't spam the source.

## Files

```
server.py                 zero-dependency server + Yahoo quote proxy
run.sh                    convenience launcher (prints your iPhone URL)
public/
  index.html              app shell
  styles.css              dark, iPhone-style UI
  app.js                  net-worth logic, add/edit, auto-refresh
  seed.js                 your starting portfolio (from the Aug 20 summary)
  manifest.webmanifest    PWA metadata (installable)
  service-worker.js       offline app shell (never caches live prices)
  icons/                  generated app icons
scripts/gen_icons.py      regenerate the app icons
```

## Notes & limitations

- "Live" prices are Yahoo's real-time/slightly-delayed quotes — great for a
  personal net-worth tracker, not for trading decisions.
- A few holdings from your summary can't be auto-priced (the CUSIPs
  `040405102`, `90118L202`, `AABAZZ`, delisted `FSRNQ`/`HLTHQ`, and the `GME+`
  line). These are pre-set as **manual** with the price you had; edit them
  anytime.
- This is for personal tracking only, not financial advice.
