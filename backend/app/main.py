"""Sales dashboard API — a server-side proxy in front of ERPNext.

Run:  uvicorn app.main:app --reload --port 8010
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .cache import clear_cache
from .config import get_settings
from .erpnext_client import ERPNextError, close_client, get_client
from .routers import sales as sales_router
from .routers import voice as voice_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_client()
    yield
    await close_client()


app = FastAPI(title="Sindh Bakery Sales API", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(ERPNextError)
async def erpnext_error_handler(_: Request, exc: ERPNextError):
    return JSONResponse(status_code=502, content={"detail": f"ERPNext error: {exc.message}", "upstream_status": exc.status_code})


app.include_router(sales_router.router)
app.include_router(voice_router.router)


@app.get("/api/health")
async def health():
    try:
        user = await get_client().ping()
        return {"status": "ok", "erpnext_user": user, "company": settings.erpnext_company,
                "voice_enabled": bool(settings.openai_api_key),
                "server_time": datetime.now(timezone.utc).isoformat()}
    except ERPNextError as exc:
        return JSONResponse(status_code=503, content={"status": "error", "detail": exc.message})


@app.post("/api/cache/clear")
async def cache_clear():
    clear_cache()
    return {"status": "cleared"}
