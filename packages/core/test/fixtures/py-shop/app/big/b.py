from app.big import a


def b1() -> int:
    return a.a2() + 1


def b2() -> int:
    return 2


def b3() -> int:
    return b2() * 3


def b4() -> int:
    return b3() + b2()
