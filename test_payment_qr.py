from binascii import crc_hqx
import unittest

from payment_qr import PaymentQrUnavailable, promptpay_payload


class PaymentQrTests(unittest.TestCase):
    def test_amount_and_recipient_are_encoded_with_checksum(self):
        payload = promptpay_payload("0812345678", "Example Shop", "50")
        self.assertEqual(
            payload[:-4],
            "00020101021229370016A00000067701011101130066812345678"
            "5303764540550.005802TH5912Example Shop6304",
        )
        self.assertEqual(int(payload[-4:], 16), crc_hqx(payload[:-4].encode("ascii"), 0xFFFF))

    def test_invalid_amount_and_missing_recipient_are_rejected(self):
        for amount in ("0", "-1", "0.001", "1e2"):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                promptpay_payload("0812345678", "Example Shop", amount)
        with self.assertRaises(PaymentQrUnavailable):
            promptpay_payload("", "Example Shop", "50")
