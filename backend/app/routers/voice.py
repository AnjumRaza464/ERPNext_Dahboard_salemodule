"""Voice control for the dashboard.

Flow: browser records speech -> /api/voice/command -> OpenAI transcription ->
OpenAI turns the sentence into dashboard actions (date range, section to open,
comparison mode, ...) -> a short spoken summary with live figures is attached.
The browser applies the actions and can read the reply aloud via /api/voice/speak.
The OpenAI key stays on the server, like the ERPNext secrets.
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..cache import cached
from ..config import get_settings
from ..dates import DateRange
from ..erpnext_client import ERPNextError
from ..services import sales

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/voice", tags=["voice"])

OPENAI_BASE = "https://api.openai.com/v1"
MAX_AUDIO_BYTES = 4_000_000  # Vercel caps request bodies at 4.5 MB; ~30 s of webm/opus is far below this

# Must match the section ids the frontend scrolls to (see frontend/src/lib/voice.ts).
SECTIONS: dict[str, str] = {
    "kpis": "headline KPI tiles: total sales, invoice count, avg invoice, qty, outstanding (top of page)",
    "pace": "daily pace: avg per day, best day, lowest day, projected month-end",
    "comparison": "comparison block: this range vs previous period / last year / custom period",
    "trend": "sales trend chart over the range (daily or monthly)",
    "monthly": "monthly sales history for last 12 months, month-on-month growth",
    "item_groups": "sales by item group / category (donut)",
    "payment_modes": "payment modes: cash, card, credit",
    "top_items": "top selling items / products",
    "pareto": "item concentration, Pareto / ABC analysis",
    "outlets": "outlet-wise / branch-wise sales",
    "composition": "sales composition waterfall: gross, discounts, taxes, returns, net",
    "heatmap": "weekday x hour heatmap",
    "by_hour": "sales by hour of day, peak hour (kis ghante / kis waqt / kis time sab se zyada sale)",
    "by_weekday": "sales by weekday, best weekday (kis din sab se zyada sale)",
    "distribution": "invoice value distribution / histogram",
    "customers": "top customers",
    "invoices": "invoice list / table of all invoices",
}
COMPARE_MODES = ("previous", "last_year", "custom")
MODE_NAMES = {"previous": "pichle period", "last_year": "pichle saal", "custom": "doosre period"}

TRANSCRIBE_HINT = (
    "Sindh Bakery sales dashboard. The speaker mixes Urdu, Hindi and English, e.g. "
    "yesterday sale, aaj ki sale, kal ki sale, parson, is hafte, is mahine, pichle mahine, "
    "comparison, last year, top items, customers, invoices, heatmap, refresh, dark mode."
)

ACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "roman": {"type": "string", "description": "the user's sentence rewritten in Roman Urdu / English letters"},
        "understood": {"type": "boolean", "description": "false if the request is not about the sales dashboard"},
        "start": {"type": ["string", "null"], "description": "new range start YYYY-MM-DD, or null to keep the current range"},
        "end": {"type": ["string", "null"], "description": "new range end YYYY-MM-DD, or null to keep the current range"},
        "section": {"type": ["string", "null"], "enum": [*SECTIONS, None]},
        "compare_mode": {"type": ["string", "null"], "enum": [*COMPARE_MODES, None]},
        "compare_start": {"type": ["string", "null"], "description": "YYYY-MM-DD, only with compare_mode=custom"},
        "compare_end": {"type": ["string", "null"], "description": "YYYY-MM-DD, only with compare_mode=custom"},
        "refresh": {"type": "boolean", "description": "true if the user asks to reload / refresh the latest data"},
        "theme": {"type": ["string", "null"], "enum": ["dark", "light", None]},
        "reply": {"type": "string", "description": "short confirmation in Roman Urdu, max 12 words, no numbers"},
    },
    "required": [
        "roman", "understood", "start", "end", "section", "compare_mode", "compare_start", "compare_end", "refresh", "theme", "reply",
    ],
}


def _anchors(today: date) -> str:
    """Pre-computed dates so the model copies them instead of doing calendar arithmetic."""
    ago = lambda n: (today - timedelta(days=n)).isoformat()  # noqa: E731
    week = today - timedelta(days=today.weekday())
    month = today.replace(day=1)
    last_month_end = month - timedelta(days=1)
    return "\n".join([
        f"- today (aaj / आज / آج): {today.isoformat()}",
        f"- yesterday (kal / कल / کل): {ago(1)}",
        f"- day before yesterday (parson / परसों / پرسوں): {ago(2)}",
        f"- this week (is hafte): {week.isoformat()} to {today.isoformat()}",
        f"- last week (pichle hafte): {(week - timedelta(days=7)).isoformat()} to {(week - timedelta(days=1)).isoformat()}",
        f"- this month (is mahine): {month.isoformat()} to {today.isoformat()}",
        f"- last month (pichle mahine): {last_month_end.replace(day=1).isoformat()} to {last_month_end.isoformat()}",
        f"- last 7 days: {ago(6)} to {today.isoformat()}; last 30 days: {ago(29)} to {today.isoformat()}",
        f"- this year (is saal): {today.replace(month=1, day=1).isoformat()} to {today.isoformat()}",
    ])


def _examples(today: date) -> str:
    y, p = (today - timedelta(days=1)).isoformat(), (today - timedelta(days=2)).isoformat()
    t, m = today.isoformat(), today.replace(day=1).isoformat()
    rows = [
        ("yesterday sale", {"start": y, "end": y, "section": "kpis"}),
        ("آج کی سیل دکھاؤ", {"roman": "aaj ki sale dikhao", "start": t, "end": t, "section": "kpis"}),
        ("comparison", {"section": "comparison"}),
        ("kal aur parson ka muqabla", {"start": y, "end": y, "section": "comparison", "compare_mode": "custom",
                                       "compare_start": p, "compare_end": p}),
        ("is mahine ka last year se comparison", {"start": m, "end": t, "section": "comparison", "compare_mode": "last_year"}),
        ("top items dikhao", {"section": "top_items"}),
    ]
    return "\n".join(f"- {q!r} -> {json.dumps(v, ensure_ascii=False)}" for q, v in rows)


def _system_prompt(today: date, current: DateRange, cmp_mode: str) -> str:
    sections = "\n".join(f"- {k}: {v}" for k, v in SECTIONS.items())
    return f"""You control a bakery sales dashboard by voice. Convert what the user said into dashboard actions.
The user speaks Urdu, Hindi, English or a mix; the transcript may be in Urdu/Devanagari script or Roman letters.
First write the sentence in Roman letters in "roman" (e.g. آج کی سیل -> "aaj ki sale"), then decide the actions from that.

Today is {today.isoformat()} ({today.strftime('%A')}). Weeks start on Monday.
Currently shown range: {current.start.isoformat()} to {current.end.isoformat()}. Current comparison mode: {cmp_mode}.

Ready-made dates (copy these exactly; never go past today):
{_anchors(today)}
Other periods: last N days -> today-(N-1)..today; a named month -> that whole month (latest one not in the future).
A single day has start = end. Whenever the user names a period (in any script), ALWAYS set start and end to it, even if
it overlaps the current range. Only if no period is named, set start and end to null (keep the current range).

Sections you can open (scroll to):
{sections}
Choose the section that best matches. Just asking for sales of a period ("yesterday sale", "aaj ki sale") -> section "kpis".

Comparison: "comparison" / "muqabla" / "compare" -> section "comparison".
"last year se" / "pichle saal" -> compare_mode "last_year"; "pichle period / pichle hafte se / pichle mahine se" when that equals the
previous same-length window -> "previous"; two explicit periods -> range = the FIRST period, compare_mode "custom",
compare_start/compare_end = the SECOND period. Example: "kal aur parson ka comparison" -> start = end = yesterday,
compare_start = compare_end = day before yesterday. Otherwise compare_mode null (keep the current one).

refresh: true only if the user asks to refresh / reload / latest data. theme: only if they ask for dark or light mode.
reply: a short friendly Roman Urdu confirmation of what you are showing, e.g. "Kal ki sale dikha raha hoon." (no numbers).
If the request has nothing to do with the dashboard, set understood=false, everything else null/false, and
reply "Maaf kijiye, main sirf sales dashboard mein madad kar sakta hoon.".

Examples (other fields null/false):
{_examples(today)}"""


def _settings_or_503():
    s = get_settings()
    if not s.openai_api_key:
        raise HTTPException(status_code=503, detail="Voice is not configured: set OPENAI_API_KEY in backend/.env")
    return s


def _openai() -> httpx.AsyncClient:
    s = _settings_or_503()
    return httpx.AsyncClient(base_url=OPENAI_BASE, headers={"Authorization": f"Bearer {s.openai_api_key}"}, timeout=60.0)


def _raise_openai(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    try:
        msg = resp.json().get("error", {}).get("message") or resp.text[:300]
    except ValueError:
        msg = resp.text[:300]
    log.warning("OpenAI error %s: %s", resp.status_code, msg)
    raise HTTPException(status_code=502, detail=f"OpenAI error {resp.status_code}: {msg}")


def _audio_filename(content_type: str) -> str:
    ct = content_type.split(";")[0].strip().lower()
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3",
           "audio/wav": "wav", "audio/x-wav": "wav", "audio/m4a": "m4a", "audio/x-m4a": "m4a"}.get(ct, "webm")
    return f"speech.{ext}"


async def _transcribe(audio: bytes, content_type: str) -> str:
    s = _settings_or_503()
    async with _openai() as client:
        try:
            resp = await client.post(
                "/audio/transcriptions",
                files={"file": (_audio_filename(content_type), audio, content_type.split(";")[0] or "audio/webm")},
                data={"model": s.openai_transcribe_model, "prompt": TRANSCRIBE_HINT, "response_format": "json"},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"OpenAI unreachable: {exc}") from exc
    _raise_openai(resp)
    return (resp.json().get("text") or "").strip()


async def _interpret(text: str, today: date, current: DateRange, cmp_mode: str) -> dict[str, Any]:
    s = _settings_or_503()
    body = {
        "model": s.openai_model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": _system_prompt(today, current, cmp_mode)},
            {"role": "user", "content": text},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "dashboard_actions", "strict": True, "schema": ACTION_SCHEMA}},
    }
    async with _openai() as client:
        try:
            resp = await client.post("/chat/completions", json=body)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"OpenAI unreachable: {exc}") from exc
    _raise_openai(resp)
    try:
        return json.loads(resp.json()["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="OpenAI returned an unexpected answer") from exc


def _parse_day(v: Any) -> date | None:
    try:
        return date.fromisoformat(str(v)) if v else None
    except ValueError:
        return None


def _clean_range(start: Any, end: Any, today: date) -> DateRange | None:
    s, e = _parse_day(start), _parse_day(end)
    if not s or not e:
        return None
    e = min(e, today)
    if s > e:
        return None
    return DateRange(s, e)


# Safety net for the most common one-day requests: the model occasionally keeps the
# current range for non-Roman transcripts (e.g. "آج کی سیل").
_DAY_WORDS = (
    (2, ("parson", "परसों", "پرسوں")),
    (1, ("yesterday", "kal", "कल", "کل")),
    (0, ("today", "aaj", "आज", "آج")),
)


def _single_day_fallback(a: dict[str, Any], text: str, today: date) -> DateRange | None:
    if a.get("compare_mode") or not a.get("understood"):
        return None
    words = set(f"{a.get('roman', '')} {text}".lower().replace("?", " ").replace(".", " ").split())
    hits = [ago for ago, keys in _DAY_WORDS if words & set(keys)]
    if len(hits) != 1:  # none, or two different days -> leave it to the model
        return None
    day = today - timedelta(days=hits[0])
    return DateRange(day, day)


def _rs(v: float) -> str:
    return f"Rs {v:,.0f}"


async def _summary(rng: DateRange, section: str | None, cmp_mode: str, cmp_rng: DateRange | None) -> str:
    """One spoken line with the live figure the user most likely wants."""
    try:
        if section == "comparison":
            cs, ce = (cmp_rng.start, cmp_rng.end) if cmp_mode == "custom" and cmp_rng else (None, None)
            key = f"sales:compare:{rng.key()}:{cmp_mode}:{cs.isoformat() if cs else ''}:{ce.isoformat() if ce else ''}"
            c, _ = await cached(key, lambda: sales.compare(rng, cmp_mode, cs, ce))
            cur, prev, d = c["current_total"], c["previous_total"], c["delta_pct"]
            name = MODE_NAMES.get(cmp_mode, "doosre period")
            if not prev:
                return f"Is period ki sale {_rs(cur)}. {name.capitalize()} mein koi sale record nahi hai."
            line = f"Is period ki sale {_rs(cur)}, {name} mein {_rs(prev)} thi."
            if d is not None:
                line += f" Yani {abs(d):.1f} percent {'zyada' if d >= 0 else 'kam'}."
            return line
        k, _ = await cached(f"sales:kpis:{rng.key()}", lambda: sales.kpis(rng))
        cur = k["current"]
        if not cur["invoice_count"]:
            return "Is period mein abhi tak koi sale record nahi hui."
        line = f"Total sale {_rs(cur['total_sales'])}, {cur['invoice_count']} invoices."
        d = k["delta_pct"].get("total_sales")
        if d is not None:
            line += f" {'Pichle din' if rng.days == 1 else 'Pichle period'} se {abs(d):.1f} percent {'zyada' if d >= 0 else 'kam'}."
        return line
    except (ERPNextError, KeyError, TypeError) as exc:
        log.warning("voice summary failed: %s", exc)
        return ""


async def _handle(text: str, today_s: str | None, start: date | None, end: date | None,
                  cmp_mode: str, cmp_start: date | None, cmp_end: date | None) -> dict[str, Any]:
    today = _parse_day(today_s) or date.today()
    # the browser's local date may be a day off the server's (UTC on Vercel); trust it within a day
    if abs((today - date.today()).days) > 1:
        today = date.today()
    current = DateRange(start or today.replace(day=1), end or today)
    cmp_mode = cmp_mode if cmp_mode in COMPARE_MODES else "previous"

    if not text:
        return {"transcript": "", "understood": False, "reply": "Maaf kijiye, awaaz saaf nahi aayi. Dobara boliye.", "actions": {}}

    a = await _interpret(text, today, current, cmp_mode)
    actions: dict[str, Any] = {}
    new_rng = _clean_range(a.get("start"), a.get("end"), today) or _single_day_fallback(a, text, today)
    if new_rng:
        actions["range"] = new_rng.as_dict()
    section = a.get("section") if a.get("section") in SECTIONS else None
    if a.get("compare_mode") in COMPARE_MODES:
        cmp_mode = a["compare_mode"]
        if section in (None, "kpis"):
            section = "comparison"
    cmp_rng = None
    if cmp_mode == "custom":
        cmp_rng = _clean_range(a.get("compare_start"), a.get("compare_end"), today) or (
            DateRange(cmp_start, cmp_end) if cmp_start and cmp_end and cmp_start <= cmp_end else None
        )
        if cmp_rng is None:  # custom without usable dates -> fall back to the previous window
            cmp_mode = "previous"
    if a.get("compare_mode") in COMPARE_MODES:
        actions["compare"] = {"mode": cmp_mode, **({"range": cmp_rng.as_dict()} if cmp_rng else {})}
    if section:
        actions["section"] = section
    if a.get("refresh"):
        actions["refresh"] = True
    if a.get("theme") in ("dark", "light"):
        actions["theme"] = a["theme"]

    understood = bool(a.get("understood")) and bool(actions)
    reply = (a.get("reply") or "").strip()
    summary = ""
    if understood and (new_rng or section in ("kpis", "comparison") or actions.get("refresh")):
        summary = await _summary(new_rng or current, section, cmp_mode, cmp_rng)
    return {
        "transcript": text,
        "understood": understood,
        "reply": reply or ("Theek hai." if understood else "Maaf kijiye, ye samajh nahi aaya."),
        "summary": summary,
        "actions": actions,
    }


@router.post("/command")
async def voice_command(
    request: Request,
    today: str | None = Query(default=None, description="browser's local date YYYY-MM-DD"),
    start: date | None = None, end: date | None = None,
    cmp_mode: str = "previous", cmp_start: date | None = None, cmp_end: date | None = None,
):
    """Raw audio body (audio/webm, audio/ogg, audio/mp4, audio/wav) -> transcript + dashboard actions."""
    _settings_or_503()
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio received")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too long, please keep it under 30 seconds")
    text = await _transcribe(audio, request.headers.get("content-type", "audio/webm"))
    return await _handle(text, today, start, end, cmp_mode, cmp_start, cmp_end)


class TextCommand(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    today: str | None = None
    start: date | None = None
    end: date | None = None
    cmp_mode: str = "previous"
    cmp_start: date | None = None
    cmp_end: date | None = None


@router.post("/text")
async def voice_text(cmd: TextCommand):
    """Same as /command but for a typed sentence (no microphone needed)."""
    return await _handle(cmd.text.strip(), cmd.today, cmd.start, cmd.end, cmd.cmp_mode, cmd.cmp_start, cmd.cmp_end)


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)


@router.post("/speak")
async def voice_speak(req: SpeakRequest):
    """Text -> MP3 speech for the assistant's reply."""
    s = _settings_or_503()
    async with _openai() as client:
        try:
            resp = await client.post("/audio/speech", json={
                "model": s.openai_tts_model,
                "voice": s.openai_tts_voice,
                "input": req.text,
                "instructions": "Speak naturally and warmly in a Pakistani Urdu accent. The text is Roman Urdu; read numbers in Urdu.",
                "response_format": "mp3",
            })
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"OpenAI unreachable: {exc}") from exc
    _raise_openai(resp)
    return Response(content=resp.content, media_type="audio/mpeg")

