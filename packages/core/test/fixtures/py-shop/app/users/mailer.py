from email.mime.text import MIMEText


def send_welcome(address: str) -> MIMEText:
    msg = MIMEText("welcome")
    msg["To"] = address
    return msg
