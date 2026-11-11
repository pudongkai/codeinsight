import os


def f(x):
    """Join a path."""
    return os.path.join("a", str(x))


def g():
    return f(1)


def rec(n):
    return rec(n - 1) if n else 0


class Base:
    pass
