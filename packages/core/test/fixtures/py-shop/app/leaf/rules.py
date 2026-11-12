def allow(qty: int) -> bool:
    return 0 < qty <= max_qty()


def max_qty() -> int:
    return 100


def describe(qty: int) -> str:
    return "ok" if allow(qty) else "too many"
