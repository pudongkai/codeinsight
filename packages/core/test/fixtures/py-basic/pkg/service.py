import json

from . import repo as r
from .repo import Base, g

HANDLERS = [r.f]
r.f(3)


def use():
    r.f(1)
    g()
    return json.dumps({})


def register(cb=r.g):
    return cb


class Service(Base):
    """Service doc."""

    def __init__(self):
        self.x = 1

    def run(self):
        return self.helper()

    def helper(self):
        def inner():
            return r.f(2)

        return inner()


def dup():
    return 1


def dup():  # noqa: F811
    return 2


def use_dup():
    return dup()
