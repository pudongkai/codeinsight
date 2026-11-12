import time


def now_ts() -> int:
    return int(time.time())


def slugify(text: str) -> str:
    return text.strip().lower().replace(" ", "-")


def chunk(items: list, size: int) -> list:
    return [items[i:i + size] for i in range(0, len(items), size)]
