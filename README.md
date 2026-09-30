# Sindh Bakery — Sales Analytics Dashboard

Live sales analytics for the **Sindh Bakery** company on ERPNext
(`https://erp.bnbcloudservices.com`). Currency: PKR.

```
backend/   FastAPI proxy in front of the ERPNext REST API (holds the API key/secret)
frontend/  Next.js (App Router) + Tailwind CSS + Recharts dashboard
```

The browser only ever talks to the FastAPI backend. ERPNext credentials live in
`backend/.env` and are never sent to the frontend.

## Run (local / office use, no login)

Backend (port **8010**):

```powershell
cd backend
python -m venv .venv            # first time only
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env          # then fill in ERPNEXT_API_KEY / ERPNEXT_API_SECRET
.\.venv\Scripts\python -m uvicorn app.main:app --port 8010
```
uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload


Frontend (port **3000**):

```powershell
cd frontend
npm install                     # first time only
npm run dev 
                    # or: npm run build && npm run start
```

Or run both at once from the project root with `.\start.ps1`.

Open http://localhost:3000. `frontend/.env.local` points at the backend
(`NEXT_PUBLIC_API_BASE=http://localhost:8010`); `backend/.env` allows that origin
via `FRONTEND_ORIGINS`.

> If the project folder is moved or renamed, recreate the venv
> (`python -m venv --clear .venv` and reinstall requirements). The launcher
> `.exe` files inside `.venv\Scripts` embed the absolute path and otherwise fail
> with "Fatal error in launcher".

## What a "bill" is (read this first)

Sales run through the ERPNext POS. Every customer bill is a **POS Invoice**. At the end of a till
session a **POS Closing Entry** consolidates the bills into one **Sales Invoice** (created later,
back-dated to the bills' day). Amounts are identical in both doctypes, but **one Sales Invoice is one
till closing, not one customer** — a day with 36 bills can have 4 Sales Invoices. Every count,
average and per-day figure on the dashboard is therefore computed from POS Invoice (plus any Sales
Invoice that did *not* come from a closing, `is_consolidated = 0`, so direct sales are not missed);
the Sales Invoice doctype is only used where the documents themselves are listed (invoice table).

Two more facts about this instance shape the numbers:

- `posting_time` is when a bill was **keyed into ERPNext**, not when the customer paid — bills are
  entered in batches (often one session of 20 min to a few hours per day). Per-hour charts therefore
  show entry progress, which is why the dashboard has no "sales by hour" card.
- A handful of early days (16 Apr, 3/5/11 May, 2 Jun 2026) hold single one-line bills of PKR 500k+
  that are opening / bulk stock entries, not retail. Those dates (`EXCLUDE_DATES_FROM_STATS`) stay in
  every total, table and monthly bar, but are left out of derived statistics: average bill, best /
  lowest day, avg per trading day, weekday and 4-week baselines. Affected tiles say so ("excl. bulk-entry din").

## Backend API

All range endpoints accept `start` and `end` (`YYYY-MM-DD`, default = current month to today, Asia/Karachi)
and `refresh=1` to bypass the 2-minute in-memory cache. Comparison endpoints accept
`mode=previous|last_week|last_year|custom` (+ `cmp_start`/`cmp_end` for custom).

| Endpoint | Data | Source |
|---|---|---|
| `GET /api/health` | ERPNext connectivity check | — |
| `GET /api/sales/kpis?mode=` | net sales, **bills**, **average bill**, qty, items per bill, trading days, deltas vs the comparison period, plus a `health` block (last bill keyed, draft / unconsolidated / cancelled bills, returns, discounts) | POS Invoice |
| `GET /api/sales/run-rate?target=` | avg per trading day, best / lowest day (bulk-entry days excluded), month-to-date, projection on the active-day pace (`remaining trading days` = calendar days left × trailing-8-week trading ratio) and the monthly **target** block (attainment %, PKR per trading day still needed, status) | POS Invoice |
| `GET /api/sales/live-compare` | live board: the day (default today) vs yesterday, vs the same day last week and vs the **4-week same-weekday average**, for net sales, bills (GCS) and average bill, with running totals by entry hour and first / last bill time; short `LIVE_CACHE_TTL_SECONDS` cache | POS Invoice |
| `GET /api/sales/weekly?week_start=` | the week day by day vs the same day last week vs the 4-week same-weekday average (only weeks in which that weekday traded), week-to-date and best day | POS Invoice |
| `GET /api/sales/compare?mode=` | current period vs the comparison period, aligned by position, cumulative curves, KPI deltas and an **attribution** of the sales change into traffic (bills) and spend (average bill) effects | POS Invoice |
| `GET /api/sales/compare-breakdown?mode=&limit=` | item groups, top items, lowest-selling items, gainers / losers and weekday averages (per trading day) side by side | POS Invoice Item |
| `GET /api/sales/pmix?mode=` | product mix: every item sold with qty / value shares, average price and the change vs the comparison period; flags new, declining (−30 % or worse) and not-sold items | POS Invoice Item |
| `GET /api/sales/item-velocity?weeks=4&limit=` | typical units per trading day per item over the last N weeks, same-weekday average for the next day, last four trading days (tomorrow's production plan) | POS Invoice Item |
| `GET /api/sales/brief?date=&target=` | Roman Urdu morning brief: last trading day, month pace vs target, this week, tomorrow's typical quantities, data notes | POS Invoice |
| `GET /api/sales/monthly?months=12` | net sales, bills, average bill, items per bill per calendar month, MoM % and YoY % (independent of `start`) | POS Invoice |
| `GET /api/sales/top-items?limit=10` | top items by value | POS Invoice Item |
| `GET /api/sales/by-item-group` | sales value, qty and distinct items per item group | POS Invoice Item |
| `GET /api/sales/by-outlet` · `/top-customers` · `/payment-modes` | per outlet / customer / payment mode (single-valued on this instance, hidden by default in the UI) | POS Invoice |
| `GET /api/sales/invoices` | all submitted Sales Invoices in range (table / CSV) — remember: one row = one till closing | Sales Invoice |
| `GET /api/sales/by-weekday` · `/by-hour` · `/trend` · `/heatmap` · `/item-pareto` · `/invoice-distribution` · `/composition` | kept for the API; no dashboard card (hour-based ones show *entry* time) | POS Invoice / Sales Invoice |
| `POST /api/cache/clear` | drop the cache | — |
| `POST /api/voice/command` | raw audio body (webm/ogg/mp4/wav) -> transcript + dashboard actions + spoken summary | OpenAI |
| `POST /api/voice/text` | same for a typed sentence `{text}` | OpenAI |
| `POST /api/voice/speak` | `{text}` -> MP3 of the reply | OpenAI |

Every payload carries `source` (`pos_invoice`, `pos_invoice_item`, `sales_invoice`, `sales_invoice_item`)
and `cached`. Older field names (`invoice_count`, `avg_invoice_value`, `total_sales`) are kept as aliases of
`checks`, `avg_check`, `net_sales`.

Call budget: a whole-dashboard refresh for a month range is about 20 ERPNext calls; the live board poll is 2
(past periods are cached for 2 minutes, only today is re-read).

Interactive docs: http://localhost:8010/docs

## Dashboard layout

Header: ERPNext connection status, the **Voice** button, an **Auto-refresh** selector (Off / 30 s / 1 / 2 / 5 / 10 min,
default `NEXT_PUBLIC_AUTO_REFRESH_SECONDS`, remembered in the browser) that reloads *every* panel from ERPNext on that
interval bypassing the backend cache (paused while the tab is hidden, fires at once when it is shown again), a countdown
to the next reload, **Refresh Now** (immediate reload, restarts the countdown) and the dark-mode toggle.

1. **KPI row** on bills: Net Sales, Bills, Avg Bill, Qty Sold, each with the % change vs the comparison basis chosen in
   the Comparison block (previous period by default). Under it a one-line **data guardrail**: last bill keyed, days
   entered, returns / discounts / cancelled, draft bills — grey when all is well, amber when entry is lagging or bills
   are pending, red when money moved out.
2. **Pace row**: avg per trading day (with bills per day), best / lowest day, and the **monthly target tile**: attainment
   %, status pill (on track / at risk / behind), PKR per remaining trading day needed, projected month-end on the
   active-day pace. Type the target on the tile (✎, remembered per month in the browser) or set `MONTHLY_TARGETS`.
3. **Subah ka brief**: three to five Roman Urdu lines (last trading day vs the same weekday, month pace vs target, this
   week, tomorrow's typical quantities, data notes) with a **Copy** button for WhatsApp. Collapsible.
4. **Today vs Yesterday vs Last Week Same Day Analysis** board (own date control): the selected day vs yesterday, vs the
   same day last week and vs the **4-week same-weekday average** (shown once that weekday traded in at least one of the
   four weeks, deltas from two), for Net Sales, Bills (GCS) and Average Bill, trading-style with ▲/▼ arrows, % and
   absolute change, tick flash on change, first / last bill time, running totals by entry hour and a side-by-side table.
   Own auto-refresh (Off / 15 s … 5 min, `NEXT_PUBLIC_LIVE_REFRESH_SECONDS`). When today has no bills yet, one click
   shows the last trading day instead.
5. **Weekly Rhythm**: the week day by day vs the same day last week and vs the 4-week same-weekday average, week-to-date
   line, previous / next week navigation, grouped bars. Tap a row for bills, avg bill and the underlying weeks.
6. **Comparison** block: choose *Previous period*, *Same days last week*, *Same period last year* (disabled until the
   data is a year old) or a *Custom period* — the choice also drives the KPI tiles and the product mix. Shows a KPI
   table on bills, the **attribution line** ("Sales −30%: kam bill (−18%) aur chhote bill (−14%)"), daily / cumulative
   curves, top items, low items and item groups.
7. **Trends, Mix & Patterns**: Monthly History (Sales / Bills / Qty toggle, table with bills and avg bill, months with
   opening entries marked), **Product Mix** (every item by qty or value with share, average price and change vs the
   comparison period; chips for *Naye* / *Girte hue* / item groups; search, sort, CSV) with a **Kal ka plan** view
   (typical units per trading day over the last 4 weeks, same-weekday average, last four days sparkline), item-group
   donut, top-items donut / bars, and the Sales Invoices table (till closings) with CSV. Outlet, payment-mode and
   customer cards only appear via a "show" link while each has a single value.

## Voice assistant

The **Voice** button in the header lets you drive the dashboard by speaking (Urdu, Hindi, English or mixed):

| Say | Dashboard does |
|---|---|
| "aaj ki sale kal se compare karo" / "live comparison" / "GCS aur average check batao" | opens the live board (moves it to the day named, if any) and reads out sales, bills and average bill vs yesterday and vs the same day last week |
| "yesterday sale" / "kal ki sale" | range = yesterday, scrolls to the KPI tiles, reads net sales, bills and average bill |
| "is hafte ka pattern batao" | scrolls to Weekly Rhythm and reads week-to-date vs last week |
| "target ka kitna hua" | scrolls to the pace row and reads month-to-date, projection and target attainment |
| "kal ka plan" / "sab se zyada bikne wali items" | scrolls to the Product Mix and reads tomorrow's top five typical quantities |
| "subah ka brief sunao" | reads the morning brief |
| "comparison" / "muqabla", "pichle hafte ke wahi dinon se compare karo" | scrolls to the comparison block (sets the basis) and reads current vs comparison period |
| "is mahine ka last year se comparison" | range = this month, comparison mode = same period last year |
| "kal aur parson ka muqabla" | range = yesterday vs custom period = day before |
| "top items", "monthly", "invoices", ... | scrolls to that panel |
| "refresh karo", "dark mode" | reloads data / switches theme |

Recording stops by itself after a short pause. Speech is transcribed and interpreted by OpenAI on the backend
(`backend/app/routers/voice.py`); the key (`OPENAI_API_KEY` in `backend/.env`) never reaches the browser. The reply is
read aloud (OpenAI TTS; mute with the speaker toggle). Commands can also be typed in the panel.
The microphone only works on `localhost` or `https` (browser rule), not on a plain `http://<LAN-IP>` address.
On Vercel add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) to the project environment variables; note that the
voice endpoints are public like the rest of the API, so anyone who can open the site can spend OpenAI credits.

## Notes on this ERPNext instance (verified 30 Sep 2026)

- One company (`Sindh Bakery`, abbr `SB`), fiscal year 2026 = calendar year, first bills 16 Apr 2026.
  **1003 submitted POS Invoices** (all status *Consolidated*) merged by **135 POS Closing Entries** into
  **132 Sales Invoices**; totals identical (PKR 34.2 M), counts differ ~7.6×. POS Closing Entry period dates
  and cash figures are unreliable (back-dated, `grand_total` 0), so no cash reconciliation is shown.
- One outlet: cost centre `outlet-1 (SB) - SB`, POS profile `POS-(Outlet-1-WW)-SB-Casher-1`. More outlets
  appear automatically once they have their own cost centre / POS profile.
- One customer (`Walk-in-customer`), one cashier user, one payment mode (Cash), no returns and no
  invoice-level discounts so far, 3 draft POS Invoices pending.
- Only 72 trading days between 16 Apr and 30 Sep 2026 (Thu 6, Sun 2 all-time), with gaps of a week or more —
  hence "per trading day" figures and the `n=` counts on weekday baselines.
- Cost data: `Sales Invoice Item.incoming_rate` is a fixed per-item transfer valuation (a third of lines show
  zero or negative margin) and the ERPNext Gross Profit report is distorted by negative stock-ledger
  valuations, so no margin card is shown until item valuation / BOM costs are cleaned up in ERPNext.
- ERPNext REST quirks: child-table queries need `parent=` plus a `parent in [...]` filter in chunks of 200;
  function expressions in aggregates and `change` as an alias are rejected; `Sales Invoice Payment` rows are
  shared by POS and Sales Invoices, so the parent filter is mandatory.

## Deploy on Vercel

The repo deploys as **one Vercel project with two services** (root `vercel.json`):

| Service | Root | Framework | Public route |
|---|---|---|---|
| `frontend` | `frontend/` | Next.js | everything except `/api/*` |
| `backend` | `backend/` | FastAPI (`app.main:app`) | `/api/*` (same origin, so no CORS config needed) |

Environment variables (Project Settings -> Environment Variables, shared by both services):
`ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_COMPANY`, `CACHE_TTL_SECONDS`, `LIVE_CACHE_TTL_SECONDS`,
`EXCLUDE_DATES_FROM_STATS`, `LIVE_EXCLUDE_DATES`, `MONTHLY_TARGETS`, `OPENAI_API_KEY`, `OPENAI_MODEL`,
`NEXT_PUBLIC_AUTO_REFRESH_SECONDS`, `NEXT_PUBLIC_LIVE_REFRESH_SECONDS`. All but the ERPNext ones are optional.
Leave `NEXT_PUBLIC_API_BASE` unset on Vercel: in production the frontend calls its own origin.
