import {Component, useEffect, useState} from "@odoo/owl";
import {CASHMATIC_STATUS_STRING} from "@pos_cashmatic_connector/utils/constants.esm";
import {CashmaticService} from "@pos_cashmatic_connector/cashmatic_service.esm";
import {Logger} from "@bus/workers/bus_worker_utils";
import {_t} from "@web/core/l10n/translation";
import {downloadFile} from "@web/core/network/download";
import {registry} from "@web/core/registry";
import {standardWidgetProps} from "@web/views/widgets/standard_widget_props";
import {useService} from "@web/core/utils/hooks";

export class CashmaticAdminButtons extends Component {
    static template = `pos_cashmatic_connector.CashmaticAdminButtons`;
    static props = {
        ...standardWidgetProps,
    };

    setup() {
        super.setup();
        this.notification = useService("notification");
        this.logger = new Logger("pos_cashmatic_connector");
        this.cashmaticService = new CashmaticService(
            (newStatus) => (this.state.status = newStatus)
        );
        this.state = useState({status: "DISCONNECTED", resetInProgress: false});

        useEffect(
            () => {
                const data = this.props.record.data;
                if (data.cashmatic_websocket_address) {
                    this.cashmaticService.connect(
                        data.cashmatic_websocket_address,
                        data.cashmatic_username,
                        data.cashmatic_password,
                        {
                            paymentTimeout: data.cashmatic_payment_timeout,
                            pollingInterval: data.cashmatic_polling_interval,
                        }
                    );
                }
            },
            () => [this.props.record.data]
        );
    }

    get status() {
        this.cashmaticService = new CashmaticService(
            (newStatus) => (this.state.status = newStatus)
        );
        return CASHMATIC_STATUS_STRING[this.state.status] ?? this.state.status;
    }

    async downloadLogs() {
        const logs = await this.logger.getLogs();
        const blob = new Blob([logs.join("\n")], {
            type: "text/plain",
        });
        const filename = `cashmatic_logs_${luxon.DateTime.now().toFormat("yyyy-LL-dd-HH-mm-ss")}.txt`;
        downloadFile(blob, filename);
    }

    async resetCashMachine() {
        if (["DISCONNECTED", "BAD_CREDENTIALS"].includes(this.state.status)) {
            this.notification.add(_t("Cashmatic is disconnected"), {type: "danger"});
            return;
        }

        this.state.resetInProgress = true;
        const clearNotification = this.notification.add(_t("Resetting Cashmatic..."), {
            type: "info",
            sticky: true,
        });

        try {
            await this.cashmaticService.reset();
            this.notification.add(_t("Reset Cashmatic complete"), {type: "info"});
        } catch (error) {
            this.notification.add(error.message || String(error), {type: "danger"});
        } finally {
            this.state.resetInProgress = false;
            clearNotification();
        }
    }
}

export const CashmaticAdminButtonsWidget = {
    component: CashmaticAdminButtons,
};
registry
    .category("view_widgets")
    .add("pos_cashmatic_admin_buttons", CashmaticAdminButtonsWidget);
