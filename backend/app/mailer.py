import mimetypes
import smtplib
from email.message import EmailMessage

from app.config import settings
from app.errors import AppError


def send_email(to: str, subject: str, body: str, attachments: list[tuple[bytes, str]] = ()) -> None:
    """attachments: [(bytes, filename)]; the type is worked out from the filename."""
    if not settings.smtp_host:
        raise AppError(503, "email_not_configured", "Email sending isn't set up (SMTP settings missing)")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.smtp_from, to, subject
    msg.set_content(body)
    for data, name in attachments:
        maintype, subtype = (mimetypes.guess_type(name)[0] or "application/octet-stream").split("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
        if settings.smtp_starttls:
            s.starttls()
        if settings.smtp_user:
            s.login(settings.smtp_user, settings.smtp_password)
        s.send_message(msg)
