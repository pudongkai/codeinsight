from app.payments import service


def record_payment(order_id: int, status: str) -> None:
    service.notify(order_id, status)


def find_payment(order_id: int) -> dict:
    return {"order_id": order_id}
