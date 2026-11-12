from app.big import b


def a1() -> int:
    return b.b1() + 1


def a2() -> int:
    return 2


def a3() -> int:
    return a2() * 3


def a4() -> int:
    return a3() + a2()
