"""Thin async wrapper around the ERPNext / Frappe REST API.

Only this module talks to ERPNext. The API key/secret never leave the server.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .config import get_settings

JSON = dict[str, Any]
PAGE_SIZE = 500


class ERPNextError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _extract_error(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:500]
    if not isinstance(body, dict):
        return resp.text[:500]
    for key in ("exception", "_error_message", "message"):
        if body.get(key):
            return str(body[key])[:500]
    if body.get("_server_messages"):
        try:
            msgs = json.loads(body["_server_messages"])
            return "; ".join(json.loads(m).get("message", "") for m in msgs)[:500]
        except Exception:  # noqa: BLE001
            pass
    return resp.text[:500]


class ERPNextClient:
    def __init__(self) -> None:
        s = get_settings()
        self.company = s.erpnext_company
        self._client = httpx.AsyncClient(
            base_url=s.erpnext_url.rstrip("/"),
            headers={
                "Authorization": f"token {s.erpnext_api_key}:{s.erpnext_api_secret}",
                "Accept": "application/json",
            },
            timeout=s.request_timeout_seconds,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ core
    async def _get(self, path: str, params: dict[str, Any]) -> JSON:
        try:
            resp = await self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            raise ERPNextError(f"ERPNext unreachable: {exc}") from exc
        if resp.status_code >= 400:
            raise ERPNextError(_extract_error(resp), status_code=resp.status_code)
        try:
            return resp.json()
        except ValueError as exc:
            raise ERPNextError("ERPNext returned a non-JSON response") from exc

    # -------------------------------------------------------------- get_list
    async def get_list(
        self,
        doctype: str,
        fields: list[str],
        filters: list[list[Any]] | dict[str, Any] | None = None,
        *,
        order_by: str | None = None,
        group_by: str | None = None,
        limit_start: int = 0,
        limit_page_length: int | None = PAGE_SIZE,
        parent: str | None = None,
    ) -> list[JSON]:
        """One page of /api/resource/<doctype>.

        `parent` is required for child-table doctypes (e.g. Sales Invoice Item
        with parent="Sales Invoice"). Aggregates like "sum(x) as y" work in fields
        together with `group_by`.
        """
        params: dict[str, Any] = {"fields": json.dumps(fields), "limit_start": limit_start}
        if filters:
            params["filters"] = json.dumps(filters)
        if order_by:
            params["order_by"] = order_by
        if group_by:
            params["group_by"] = group_by
        if parent:
            params["parent"] = parent
        params["limit_page_length"] = 0 if limit_page_length is None else limit_page_length
        data = await self._get(f"/api/resource/{doctype}", params)
        return data.get("data", [])

    async def get_all(
        self,
        doctype: str,
        fields: list[str],
        filters: list[list[Any]] | dict[str, Any] | None = None,
        *,
        order_by: str | None = None,
        parent: str | None = None,
        page_size: int = PAGE_SIZE,
        max_rows: int = 50_000,
    ) -> list[JSON]:
        """All rows, auto-paginated."""
        rows: list[JSON] = []
        start = 0
        while True:
            page = await self.get_list(
                doctype, fields, filters, order_by=order_by, limit_start=start,
                limit_page_length=page_size, parent=parent,
            )
            rows.extend(page)
            if len(page) < page_size or len(rows) >= max_rows:
                return rows
            start += page_size

    async def get_count(self, doctype: str, filters: list[list[Any]] | dict[str, Any] | None = None) -> int:
        params: dict[str, Any] = {"doctype": doctype}
        if filters:
            params["filters"] = json.dumps(filters)
        data = await self._get("/api/method/frappe.client.get_count", params)
        return int(data.get("message", 0))

    # ------------------------------------------------------------- reports
    async def run_report(self, report_name: str, filters: dict[str, Any]) -> JSON:
        """frappe.desk.query_report.run -> {result, columns, report_summary, ...}."""
        data = await self._get(
            "/api/method/frappe.desk.query_report.run",
            {"report_name": report_name, "filters": json.dumps(filters), "ignore_prepared_report": 1},
        )
        msg = data.get("message")
        if not isinstance(msg, dict) or "result" not in msg:
            raise ERPNextError(f"Report '{report_name}' returned an unexpected payload")
        return msg

    async def call_method(self, method: str, **params: Any) -> Any:
        data = await self._get(f"/api/method/{method}", params)
        return data.get("message")

    async def ping(self) -> str:
        return str(await self.call_method("frappe.auth.get_logged_user"))


_client: ERPNextClient | None = None


def get_client() -> ERPNextClient:
    global _client
    if _client is None:
        _client = ERPNextClient()
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
