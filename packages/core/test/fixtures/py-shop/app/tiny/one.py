from app.users import service


def ping() -> dict:
    return service.get_user(0)
