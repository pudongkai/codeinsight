from app.big import c


def d1() -> int:
    return c.c2() + 1


def d2() -> int:
    return 2


def d3() -> int:
    return d2() * 3


def d4() -> int:
    return d3() + d2()
