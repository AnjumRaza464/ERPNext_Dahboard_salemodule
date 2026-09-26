"""In-memory TTL cache with per-key locks so concurrent identical requests
hit ERPNext only once."""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Awaitable, Callable

from cachetools import TTLCache

from .config import get_settings

_cache: TTLCache = TTLCache(maxsize=1024, ttl=get_settings().cache_ttl_seconds)
_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


async def cached(key: str, producer: Callable[[], Awaitable[Any]], *, refresh: bool = False) -> tuple[Any, bool]:
    """Return (value, was_cached)."""
    if not refresh and key in _cache:
        return _cache[key], True
    async with _locks[key]:
        if not refresh and key in _cache:
            return _cache[key], True
        value = await producer()
        _cache[key] = value
        return value, False


def clear_cache() -> None:
    _cache.clear()
