from fastapi import FastAPI

from app.orders.api import router as orders_router
from app.payments.api import router as payments_router
from app.users.api import router as users_router


def create_app() -> FastAPI:
    application = FastAPI()
    application.include_router(orders_router)
    application.include_router(payments_router)
    application.include_router(users_router)
    application.add_event_handler("startup", on_startup)
    return application


def health() -> dict:
    return {"ok": True}


def on_startup() -> None:
    health()


app = create_app()
