from app.big import d


def c1() -> int:
    return d.d1() + 1


def c2() -> int:
    return 2


def c3() -> int:
    return c2() * 3


def c4() -> int:
    return c3() + c2()
