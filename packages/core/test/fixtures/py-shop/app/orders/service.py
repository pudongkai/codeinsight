from app.common.utils import now_ts
from app.orders import repository
from app.payments import service as payments


def _calc(qty: int, price: float) -> float:
    return qty * price


def create_order(sku: str, qty: int) -> dict:
    total = _calc(qty, 10.0)
    order_id = repository.save_order(sku, qty, total)
    payments.charge(order_id, total)
    return {"id": order_id, "total": total, "at": now_ts()}


def refund(order_id: int) -> dict:
    order = repository.load_order(order_id)
    payments.refund_payment(order_id, order["total"])
    return {"id": order_id, "refunded": True}


def mark_paid(order_id: int) -> None:
    repository.update_status(order_id, "paid")
