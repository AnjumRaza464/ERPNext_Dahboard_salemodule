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
