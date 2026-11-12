from app.orders.service import _calc


def test_calc():
    assert _calc(2, 1.5) == 3.0
