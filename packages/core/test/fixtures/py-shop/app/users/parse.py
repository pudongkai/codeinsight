from email.utils import parseaddr


def parse_address(raw: str) -> str:
    return parseaddr(raw)[1]
