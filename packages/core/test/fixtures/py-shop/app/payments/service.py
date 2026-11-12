import httpx
import stripe

from app.orders import service as orders


def charge(order_id: int, amount: float) -> str:
    intent = stripe.PaymentIntent.create(amount=int(amount * 100), currency="usd", metadata={"order_id": order_id})
    return intent.id


def refund_payment(order_id: int, amount: float) -> None:
    stripe.Refund.create(amount=int(amount * 100), metadata={"order_id": order_id})


def handle_webhook(order_id: int, status: str) -> None:
    if status == "succeeded":
        orders.mark_paid(order_id)
    notify(order_id, status)


def notify(order_id: int, status: str) -> None:
    httpx.post("https://hooks.example.com/payments", json={"order_id": order_id, "status": status})
