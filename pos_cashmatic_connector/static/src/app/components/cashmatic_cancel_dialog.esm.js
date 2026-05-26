import {Component} from "@odoo/owl";
import {Dialog} from "@web/core/dialog/dialog";

export class CashmaticCancelDialog extends Component {
    static template = "pos_cashmatic_connector.CashmaticCancelDialog";
    static components = {Dialog};
    static props = {
        message: String,
        cancel: Function,
        close: Function,
    };
}
