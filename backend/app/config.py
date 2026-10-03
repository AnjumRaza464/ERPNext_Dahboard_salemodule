from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration. Secrets live only here (server side)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    erpnext_url: str = Field(default="https://erp.bnbcloudservices.com")
    # Empty defaults let the app boot before secrets are configured (e.g. first Vercel deploy);
    # every ERPNext call then fails with a clear 401 -> 502 instead of an import-time crash.
    erpnext_api_key: str = ""
    erpnext_api_secret: str = ""
    erpnext_company: str = "Sindh Bakery"
    frontend_origins: str = "http://localhost:3000"
    cache_ttl_seconds: int = 120
    # The live comparison board polls often; keep its answers only briefly so refreshes stay fresh.
    live_cache_ttl_seconds: int = 15
    request_timeout_seconds: float = 60.0

    # Days whose bills are opening / bulk stock entries rather than retail sales (single one-line
    # bills of PKR 500k+). Their totals stay in every sum and table, but they are left out of
    # derived statistics: best / lowest day, averages per bill or per day, weekday baselines.
    exclude_dates_from_stats: str = "2026-04-16,2026-05-03,2026-05-05,2026-05-11,2026-06-02"
    # Extra dates (closures, Eid) to leave out of the live board's 4-week same-weekday baseline.
    live_exclude_dates: str = ""
    # Monthly net-sales targets, e.g. "2026-10:4500000,default:4000000". The browser can override
    # per month; nothing is stored in ERPNext.
    monthly_targets: str = ""

    # Placeholder items used for opening stock and one-off conversions (a lump "All B&B Raw" bought on 31 Mar 2026,
    # turned into a dummy "Raw Material Cake" and later broken down again). Their stock entry and purchase lines are
    # left out of every Costing figure, otherwise the same material is counted two or three times.
    costing_exclude_items: str = "Raw Material Cake,All B&B Raw,All B&B F.G"

    @property
    def costing_excluded_items(self) -> set[str]:
        return {x.strip().lower() for x in self.costing_exclude_items.split(",") if x.strip()}

    @property
    def excluded_dates(self) -> set[str]:
        return {d.strip() for d in self.exclude_dates_from_stats.split(",") if d.strip()}

    @property
    def live_excluded_dates(self) -> set[str]:
        return {d.strip() for d in self.live_exclude_dates.split(",") if d.strip()} | self.excluded_dates

    def monthly_target(self, month_key: str) -> float | None:
        """Target for 'YYYY-MM' from MONTHLY_TARGETS, falling back to the 'default' entry."""
        table: dict[str, float] = {}
        for part in self.monthly_targets.split(","):
            if ":" in part:
                k, v = part.split(":", 1)
                try:
                    table[k.strip()] = float(v.strip())
                except ValueError:
                    continue
        value = table.get(month_key, table.get("default"))
        return value if value and value > 0 else None

    # Voice assistant (OpenAI). Empty key disables /api/voice/* with a clear 503.
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_transcribe_model: str = "gpt-4o-mini-transcribe"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "alloy"

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
