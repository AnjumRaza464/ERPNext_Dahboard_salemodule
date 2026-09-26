from __future__ import annotations

from datetime import date, timedelta

from fastapi import HTTPException, Query


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

    @property
    def granularity(self) -> str:
        return "day" if self.days <= 92 else "month"

    def key(self) -> str:
        return f"{self.start.isoformat()}_{self.end.isoformat()}"

    def as_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


def date_range(
    start: date | None = Query(default=None, description="YYYY-MM-DD; default = 1st of current month"),
    end: date | None = Query(default=None, description="YYYY-MM-DD; default = today"),
) -> DateRange:
    today = date.today()
    return DateRange(start or today.replace(day=1), end or today)
