from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Provided by the coders.kr platform via coders.yaml substitution.
    database_url: str = "postgresql+asyncpg://app:app@localhost:5432/app"

    # Local-dev escape hatch: when set, an X-Coders-User-less request is
    # treated as if it came from this UUID. Lets you `curl` the API
    # without the platform gate in front. Never set in production.
    dev_fake_user: str | None = None

    # StealthMole hackathon API. Secrets live in backend/.env (gitignored) in
    # dev and in the platform's env at deploy time — never in the repo.
    stealthmole_host: str = "https://hackathon.stealthmole.com"
    stealthmole_access_key: str | None = None
    stealthmole_secret_key: str | None = None
    stealthmole_account: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
