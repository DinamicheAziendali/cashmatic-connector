import {PaymentCashmatic} from "@pos_cashmatic_connector/app/payment_cashmatic.esm";
import {PosStore} from "@point_of_sale/app/services/pos_store";
import {patch} from "@web/core/utils/patch";

patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData();
        for (const pm of this.models["pos.payment.method"].getAll()) {
            if (pm.payment_method_type === "cashmatic") {
                pm.payment_terminal = new PaymentCashmatic(this, pm);
            }
        }
    },
});
