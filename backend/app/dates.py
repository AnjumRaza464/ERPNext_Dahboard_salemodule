from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Query

# The bakery's clock. Vercel functions run in UTC, which is a day behind Pakistan between
# midnight and 05:00 PKT, so "today" must be computed in the local zone.
LOCAL_TZ = ZoneInfo("Asia/Karachi")


def now_local() -> datetime:
    return datetime.now(LOCAL_TZ)


def today_local() -> date:
    return now_local().date()


class DateRange:
    def __init__(self, start: date, end: date):
        if start > end:
            raise HTTPException(status_code=422, detail="start must be on or before end")
        self.start = start
        self.end = end

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def previous(self) -> "DateRange":
        """Same-length window immediately before this one (for deltas)."""
        prev_end = self.start - timedelta(days=1)
        return DateRange(prev_end - timedelta(days=self.days - 1), prev_end)

    def shift(self, days: int) -> "DateRange":
        return DateRange(self.start + timedelta(days=days), self.end + timedelta(days=days))

    @property
    def granularity(self) -> str:
        return "day" if self.days <= 92 else "month"

    def key(self) -> str:
        return f"{self.start.isoformat()}_{self.end.isoformat()}"

    def as_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


def date_range(
    start: date | None = Query(default=None, description="YYYY-MM-DD; default = 1st of current month (Asia/Karachi)"),
    end: date | None = Query(default=None, description="YYYY-MM-DD; default = today (Asia/Karachi)"),
) -> DateRange:
    today = today_local()
    return DateRange(start or today.replace(day=1), end or today)
