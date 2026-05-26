# Copyright (C) 2026-Today:
# Dinamiche Aziendali srl (<http://www.dinamicheaziendali.it/>)
# @author: Giuseppe Borruso (gborruso@dinamicheaziendali.it)
# License GPL-3.0 or later (http://www.gnu.org/licenses/gpl.html).

{
    "name": "POS Cashmatic Connector",
    "version": "19.0.1.0.0",
    "category": "Sales/Point of Sale",
    "summary": "Allows communication between Odoo PoS and Cashmatic devices",
    "website": "https://www.dinamicheaziendali.it/",
    "license": "AGPL-3",
    "author": "Dinamiche Aziendali srl",
    "depends": ["point_of_sale"],
    "data": [
        "views/pos_payment_method_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "pos_cashmatic_connector/static/src/**/*",
            ("remove", "pos_cashmatic_connector/static/src/app/**/*"),
        ],
        "point_of_sale._assets_pos": [
            "pos_cashmatic_connector/static/src/**/*",
            ("remove", "pos_cashmatic_connector/static/src/backend/**/*"),
        ],
    },
    "images": ["static/description/icon.png"],
    "installable": True,
}
