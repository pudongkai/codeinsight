from app.leaf.rules import max_qty


def remaining(used: int) -> int:
    return max_qty() - used


def is_full(used: int) -> bool:
    return remaining(used) <= 0
