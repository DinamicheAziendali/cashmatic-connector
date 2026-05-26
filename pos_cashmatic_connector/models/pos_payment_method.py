# Copyright (C) 2026-Today:
# Dinamiche Aziendali Srl (<http://www.dinamicheaziendali.it/>)
# @author: Giuseppe Borruso <gborruso@dinamicheaziendali.it>
# License GPL-3.0 or later (http://www.gnu.org/licenses/gpl.html).

from odoo import fields, models


class PosPaymentMethodInherit(models.Model):
    _inherit = "pos.payment.method"

    cashmatic_websocket_address = fields.Char(
        string="Cashmatic API URL",
        default="https://127.0.0.1:50301",
        help="Cashmatic REST Service Local URL, for example https://127.0.0.1:50301",
    )
    cashmatic_username = fields.Char(default="cashmatic")
    cashmatic_password = fields.Char(default="admin")
    cashmatic_payment_timeout = fields.Integer(
        string="Payment Timeout (seconds)",
        default=120,
    )
    cashmatic_polling_interval = fields.Integer(
        string="Polling Interval (ms)",
        default=350,
        help="Interval used by the POS browser to poll ActiveTransaction.",
    )

    def _get_payment_method_type(self):
        return super()._get_payment_method_type() + [
            ("cashmatic", "Cash Machine (Cashmatic)")
        ]

    def _load_pos_data_fields(self, config_id):
        return super()._load_pos_data_fields(config_id) + [
            "cashmatic_websocket_address",
            "cashmatic_username",
            "cashmatic_password",
            "cashmatic_payment_timeout",
            "cashmatic_polling_interval",
        ]
