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

## Backend API

All endpoints accept `start` and `end` (`YYYY-MM-DD`, default = current month to
today) and `refresh=1` to bypass the 2-minute in-memory cache.

| Endpoint | Data | Source |
|---|---|---|
| `GET /api/health` | ERPNext connectivity check | — |
| `GET /api/sales/kpis` | total sales, invoice count, avg invoice, outstanding, deltas vs previous period | Sales Invoice |
| `GET /api/sales/invoices` | all submitted invoices in range (table / CSV) | Sales Invoice |
| `GET /api/sales/trend` | daily (≤92 days) or monthly sales | Sales Invoice |
| `GET /api/sales/top-items?limit=10` | top items by value | Sales Invoice Item (`parent` param) |
| `GET /api/sales/by-outlet` | sales per cost centre / POS profile | Sales Invoice |
| `GET /api/sales/compare?mode=previous\|last_year\|custom&cmp_start=&cmp_end=` | current period vs a comparison period (previous same-length window, same dates last year, or any custom range), aligned by day/month, with cumulative curves and KPI deltas | Sales Invoice |
| `GET /api/sales/compare-breakdown?mode=…&limit=10` | item groups, top items, biggest gainers / losers and weekday averages side by side for the two periods | Sales Invoice Item |
| `GET /api/sales/monthly?months=12` | net sales per calendar month ending in the month of `end`, with MoM % and YoY % (independent of `start`) | Sales Invoice |
| `GET /api/sales/heatmap` | average sales per weekday × hour cell, peak cell | Sales Invoice (`posting_time`) |
| `GET /api/sales/item-pareto?limit=30` | ABC / Pareto: item share and cumulative share, class A/B/C counts (80 / 95 %) | Sales Invoice Item |
| `GET /api/sales/run-rate` | avg per calendar / active day, best and lowest day, month-to-date and straight-line projection for the month of `end` | Sales Invoice |
| `GET /api/sales/by-item-group` | sales value, qty and item count per item group | Sales Invoice Item |
| `GET /api/sales/by-hour` | sales per hour of day, peak hour, average per trading day | Sales Invoice (`posting_time`) |
| `GET /api/sales/by-weekday` | total and average sales per weekday | Sales Invoice |
| `GET /api/sales/invoice-distribution` | invoice value histogram + median / mean / p90 | Sales Invoice |
| `GET /api/sales/top-customers?limit=10` | top customers by value, invoices, outstanding, last invoice | Sales Invoice |
| `GET /api/sales/payment-modes` | Cash / Card / … split of settled sales, plus credit remainder | Sales Invoice Payment |
| `GET /api/sales/composition` | gross → discounts → taxes → returns → net (waterfall) | Sales Invoice |
| `POST /api/cache/clear` | drop the cache | — |

Every payload carries `source` (`sales_invoice` or `sales_invoice_item`) and
`cached` (whether it was served from the 2-minute cache).

Interactive docs: http://localhost:8010/docs

## Dashboard layout

1. KPI row (totals vs previous period) and a **pace row** (avg per active day, best / lowest day, projected month-end).
2. **Comparison** block: choose *Previous period*, *Same period last year* or a *Custom period*; shows a KPI
   side-by-side table, daily / cumulative curves, item-group, top-item and weekday comparisons, and the biggest movers.
   The chosen mode and custom dates are remembered in the browser.
3. Trends, mix & patterns: sales trend, 12-month history (MoM), item-group and payment-mode donuts, top items
   (bars or share donut), Pareto / ABC concentration, weekday × hour heatmap, hour / weekday columns, invoice
   value distribution, composition waterfall, outlets, top customers, and the invoice table.

## Notes on this ERPNext instance (verified 26 Sep 2026)

- One company (`Sindh Bakery`, abbr `SB`), fiscal year 2026. Sales run through the
  POS: **956 submitted POS Invoices** (the real till transactions, doctype
  `POS Invoice`, all status *Consolidated*) since 16 Apr 2026, merged by
  **129 POS Closing Entries** into **126 Sales Invoices**. Amount totals are identical
  in both doctypes, but counts, averages and posting times differ: one Sales
  Invoice = one till closing, not one customer.
- One outlet: cost centre `outlet-1 (SB) - SB`, POS profile
  `POS-(Outlet-1-WW)-SB-Casher-1`. More outlets appear automatically once they
  have their own cost centre / POS profile.
- One customer (`Walk-in-customer`), one cashier user, one payment mode (Cash),
  no returns and no invoice-level discounts so far.

## Deploy on Vercel

The repo is deployed as **two Vercel projects** from the same GitHub repository:

| Project | Root Directory | Framework | Environment variables |
|---|---|---|---|
| Backend API | `backend` | FastAPI (zero-config, entrypoint `app/main.py`) | `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_COMPANY`, `FRONTEND_ORIGINS` (= the frontend's Vercel URL), `CACHE_TTL_SECONDS` |
| Dashboard | `frontend` | Next.js | `NEXT_PUBLIC_API_BASE` (= the backend's Vercel URL, no trailing slash) |

`backend/vercel.json` only raises the function timeout to 60 s for slow ERPNext queries.
