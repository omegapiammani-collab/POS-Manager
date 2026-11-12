"""Generate a Thai QR Payment image for a locally configured PromptPay mobile number."""
from binascii import crc_hqx
import os
import re


class PaymentQrUnavailable(Exception):
    pass


def field(tag, value):
    return f"{tag}{len(value):02d}{value}"


def promptpay_payload(mobile, merchant_name, amount):
    if not re.fullmatch(r"0[689][0-9]{8}", mobile):
        raise PaymentQrUnavailable("Configure a Thai PromptPay mobile number")
    if not re.fullmatch(r"[ -~]{1,25}", merchant_name):
        raise PaymentQrUnavailable("Configure a merchant name with 1–25 ASCII characters")
    if not re.fullmatch(r"[0-9]{1,10}(?:\.[0-9]{1,2})?", amount):
        raise ValueError("QR amount must have up to two decimal places")

    whole, _, fraction = amount.partition(".")
    satang = int(whole) * 100 + int(fraction.ljust(2, "0"))
    if not 0 < satang <= 100000000000:
        raise ValueError("QR amount is outside the supported range")
    total = f"{satang // 100}.{satang % 100:02d}"
    account = field("00", "A000000677010111") + field("01", "0066" + mobile[1:])
    payload = (
        field("00", "01") + field("01", "12") + field("29", account)
        + field("53", "764") + field("54", total) + field("58", "TH")
        + field("59", merchant_name) + "6304"
    )
    return payload + f"{crc_hqx(payload.encode('ascii'), 0xFFFF):04X}"


def payment_qr_svg(amount):
    payload = promptpay_payload(
        os.environ.get("POS_PROMPTPAY_MOBILE", "").strip(),
        os.environ.get("POS_PROMPTPAY_NAME", "").strip(),
        amount,
    )
    try:
        import qrcode
        from qrcode.image.svg import SvgPathFillImage
    except ImportError as exc:
        raise PaymentQrUnavailable("Install the optional qrcode dependency") from exc
    image = qrcode.make(payload, image_factory=SvgPathFillImage)
    return image.to_string()
