from app.orders.service import _calc


def get_user(user_id: int) -> dict:
    return {"id": user_id, "email": f"user{user_id}@example.com"}


def quote_for_user(user_id: int, qty: int) -> float:
    get_user(user_id)
    return _calc(qty, 9.5)
