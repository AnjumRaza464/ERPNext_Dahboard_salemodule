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
    request_timeout_seconds: float = 60.0

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
