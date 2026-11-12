from fastapi import APIRouter
from pydantic import BaseModel

from app.payments import service

router = APIRouter()


class PaymentEvent(BaseModel):
    order_id: int
    status: str


@router.post("/payments/webhook")
def webhook(body: PaymentEvent) -> dict:
    service.handle_webhook(body.order_id, body.status)
    return {"ok": True}
