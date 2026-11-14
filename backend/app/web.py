"""Single-service entrypoint (Railway): the API under /api and the built frontend everywhere else.

    uvicorn app.web:app

One process instead of an API container plus a web server container: half the always-on memory. The frontend's
fingerprinted files are cached by browsers for a year and served pre-compressed (brotli/gzip, made at build time),
so repeat visits download almost nothing.
"""

import mimetypes
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, PlainTextResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import settings
from app.main import app as api

for ext, mime in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml"),
                  (".woff2", "font/woff2"), (".webp", "image/webp"), (".json", "application/json")):
    mimetypes.add_type(mime, ext)  # slim images ship without /etc/mime.types

DIST = Path(settings.frontend_dir).resolve() if settings.frontend_dir else None
YEAR = "public, max-age=31536000, immutable"


async def frontend(request: Request):
    if DIST is None:
        return PlainTextResponse("Frontend not built (set FRONTEND_DIR)", status_code=404)
    file = (DIST / request.path_params["path"]).resolve()
    if not file.is_relative_to(DIST) or not file.is_file():
        file = DIST / "index.html"  # an app route like /orders/12: the SPA handles it
    if file.name == "index.html":
        cache = "no-cache"  # always check for a new release
    elif file.parent.name == "assets":
        cache = YEAR  # Vite fingerprints these: a changed file gets a new name
    else:
        cache = "public, max-age=86400"  # favicon and other unhashed public files
    headers = {"Cache-Control": cache, "Vary": "Accept-Encoding"}
    media_type = mimetypes.guess_type(file.name)[0]
    accepted = request.headers.get("accept-encoding", "")
    for encoding, suffix in (("br", ".br"), ("gzip", ".gz")):
        packed = file.with_name(file.name + suffix)
        if encoding in accepted and packed.is_file():
            return FileResponse(packed, media_type=media_type, headers={**headers, "Content-Encoding": encoding})
    return FileResponse(file, media_type=media_type, headers=headers)


class SecurityHeaders:
    """What the Caddy config added on a server; Railway's edge terminates TLS but doesn't add these."""

    HEADERS = ((b"strict-transport-security", b"max-age=31536000"), (b"x-content-type-options", b"nosniff"),
               (b"x-frame-options", b"DENY"), (b"referrer-policy", b"strict-origin-when-cross-origin"))

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [*message.get("headers", []), *self.HEADERS]
            await send(message)

        await self.app(scope, receive, with_headers if scope["type"] == "http" else send)


app = SecurityHeaders(Starlette(routes=[Mount("/api", app=api), Route("/{path:path}", frontend)]))
