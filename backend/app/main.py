from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.database import AsyncSessionLocal
from app.routes.beliefs import router as beliefs_router
from app.routes.cases import router as cases_router
from app.routes.graph import router as graph_router
from app.routes.live import router as live_router
from app.routes.users import router as users_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(
    title="STEALTHGRAPH API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.include_router(users_router)
app.include_router(graph_router)
app.include_router(beliefs_router)
app.include_router(live_router)
app.include_router(cases_router)


@app.get("/api/health")
async def health() -> JSONResponse:
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(
            status_code=503, content={"status": "error", "detail": "database"}
        )
    return JSONResponse(content={"status": "ok"})


@app.get("/api/health/live")
async def liveness() -> JSONResponse:
    """Liveness probe — answers the instant this process can serve a request,
    touching NOTHING (no DB, no I/O). The frontend's warming banner
    (frontend/lib/warming.ts) hits this to tell a real cold start apart from a
    merely slow request: when the api KSvc is scaled to zero, Knative's
    activator buffers this until a pod is up, so the probe is slow ⇔ the server
    is genuinely waking. When warm it returns in ~1ms even while a heavy
    endpoint is still in flight — so the banner stays off for ordinary slowness.
    Keep it dependency-free; adding a DB hit here would reintroduce false
    'warming' whenever the DB (not the pod) is the slow part."""
    return JSONResponse(content={"status": "ok"})
