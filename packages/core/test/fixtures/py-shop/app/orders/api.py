from fastapi import APIRouter
from pydantic import BaseModel

from app.orders import repository, service

router = APIRouter()


class OrderIn(BaseModel):
    sku: str
    qty: int


class OrderOut(BaseModel):
    id: int
    total: float


@router.get("/orders/{order_id}")
def get_order(order_id: int) -> OrderOut:
    row = repository.load_order(order_id)
    return OrderOut(id=row["id"], total=row["total"])


@router.post("/orders")
def create_order(body: OrderIn) -> OrderOut:
    order = service.create_order(body.sku, body.qty)
    return OrderOut(id=order["id"], total=order["total"])


@router.post("/orders/{order_id}/refund")
def refund_order(order_id: int) -> dict:
    return service.refund(order_id)
