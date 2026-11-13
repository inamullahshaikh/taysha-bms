from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


class AppError(Exception):
    """Raise anywhere to return {code, message, fields} with the given HTTP status."""

    def __init__(self, status: int, code: str, message: str, fields: dict | None = None):
        self.status, self.code, self.message, self.fields = status, code, message, fields


def error_body(code: str, message: str, fields: dict | None = None) -> dict:
    return {"code": code, "message": message, "fields": fields or {}}


def not_found(what: str = "Record") -> AppError:
    return AppError(404, "not_found", f"{what} not found")


def conflict(message: str, code: str = "conflict") -> AppError:
    return AppError(409, code, message)


def install(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app(_: Request, e: AppError):
        return JSONResponse(error_body(e.code, e.message, e.fields), status_code=e.status)

    @app.exception_handler(HTTPException)
    async def _http(_: Request, e: HTTPException):
        return JSONResponse(error_body("http_error", str(e.detail)), status_code=e.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, e: RequestValidationError):
        fields = {".".join(str(p) for p in err["loc"][1:]) or str(err["loc"][0]): err["msg"] for err in e.errors()}
        return JSONResponse(error_body("validation_error", "Invalid input", fields), status_code=422)
