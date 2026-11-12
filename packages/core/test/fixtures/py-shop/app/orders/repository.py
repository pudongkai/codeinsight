import psycopg


def save_order(sku: str, qty: int, total: float) -> int:
    with psycopg.connect() as conn:
        row = conn.execute("insert into orders (sku, qty, total) values (%s, %s, %s) returning id", (sku, qty, total)).fetchone()
        return row[0]


def load_order(order_id: int) -> dict:
    with psycopg.connect() as conn:
        row = conn.execute("select id, total from orders where id = %s", (order_id,)).fetchone()
        return {"id": row[0], "total": row[1]}


def update_status(order_id: int, status: str) -> None:
    with psycopg.connect() as conn:
        conn.execute("update orders set status = %s where id = %s", (status, order_id))
