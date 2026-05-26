import {AlertDialog} from "@web/core/confirmation_dialog/confirmation_dialog";
import {CASHMATIC_STATUS_STRING} from "@pos_cashmatic_connector/utils/constants.esm";
import {CashmaticCancelDialog} from "@pos_cashmatic_connector/app/components/cashmatic_cancel_dialog.esm";
import {CashmaticService} from "@pos_cashmatic_connector/cashmatic_service.esm";
import {PaymentInterface} from "@point_of_sale/app/utils/payment/payment_interface";
import {_t} from "@web/core/l10n/translation";

const CONNECT_TIMEOUT_MS = 6000;

export class PaymentCashmatic extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this.dialog = this.env.services.dialog;
        this.cancellationResolver = null;
        this.cashmaticService = new CashmaticService(this.onStatusChange.bind(this));
        this.cashmaticService.connect(
            this.payment_method_id.cashmatic_websocket_address,
            this.payment_method_id.cashmatic_username,
            this.payment_method_id.cashmatic_password,
            {
                paymentTimeout: this.payment_method_id.cashmatic_payment_timeout,
                pollingInterval: this.payment_method_id.cashmatic_polling_interval,
            }
        );

        setTimeout(() => {
            if (this.cashmaticService.status === "DISCONNECTED") {
                this.onStatusChange("DISCONNECTED");
            }
        }, CONNECT_TIMEOUT_MS);
    }

    onStatusChange(newStatus) {
        switch (newStatus) {
            case "DISCONNECTED": {
                this.showError(
                    _t(
                        "Failed to connect to Cashmatic, please check URL, CORS and local HTTPS certificate."
                    )
                );
                return;
            }
            case "BAD_CREDENTIALS": {
                this.showError(
                    _t(
                        "Failed to login to Cashmatic, please check the configured username and password."
                    )
                );
                return;
            }
            case "WAITING_ERROR_RECOVERY":
            case "DEVICE_NOT_ACTIVE":
            case "CASH_FUND_LOW":
            case "ERROR": {
                if (this.paymentLine) {
                    this.showError(this.currentErrorMessage);
                }
                return;
            }
            case "WAITING_CANCEL": {
                if (this.paymentLine) {
                    this.showCashmaticCancelDialog(
                        _t(
                            "There is insufficient change in Cashmatic to handle the payment. It must be cancelled to continue."
                        )
                    );
                }
                return;
            }
        }
    }

    get status() {
        return (
            CASHMATIC_STATUS_STRING[this.cashmaticService.status] ??
            this.cashmaticService.status
        );
    }

    get amountInserted() {
        return this.cashmaticAmountToPosAmount(
            this.cashmaticService.state.amountInserted
        );
    }

    get paymentLine() {
        const order = this.pos.getOrder();
        if (!order) {
            return null;
        }

        const cashmaticPaymentLines = order.payment_ids.filter(
            (line) => line.payment_method_id === this.payment_method_id
        );

        return cashmaticPaymentLines.find((line) =>
            ["waiting", "waitingCancel"].includes(line.payment_status)
        );
    }

    getDenominationsWithStatus(status) {
        return this.cashmaticService.state.inventory
            .filter((denomination) => denomination.status === status)
            .map((denomination) => ({
                ...denomination,
                value: this.cashmaticAmountToPosAmount(denomination.value),
            }));
    }

    get currentErrorMessage() {
        return (
            this.cashmaticService.state.lastDeviceError ??
            _t("Cashmatic has an error, please consult its display for details.")
        );
    }

    // eslint-disable-next-line complexity
    async sendPaymentRequest() {
        if (!this.paymentLine) {
            return false;
        }

        if (this.paymentLine.amount < 0) {
            this.showError(_t("Cashmatic payments cannot be negative."));
            return false;
        }

        const amountInCents = Math.round(
            this.paymentLine.amount * Math.pow(10, this.pos.currency.decimal_places)
        );
        const paymentResult =
            await this.cashmaticService.sendPaymentRequest(amountInCents);

        if (!this.paymentLine) {
            console.warn(
                "Cashmatic payment response received, but no payment in progress"
            );
            return false;
        }

        if (this.cancellationResolver) {
            this.cancellationResolver(paymentResult.status === "CANCEL");
            this.cancellationResolver = null;
        }

        switch (paymentResult.status) {
            case "DISCONNECTED":
            case "BAD_CREDENTIALS": {
                this.showError(_t("Cashmatic is disconnected."));
                return false;
            }
            case "ERROR":
            case "WAITING_ERROR_RECOVERY":
            case "DEVICE_NOT_ACTIVE":
            case "CASH_FUND_LOW": {
                this.showError(this.currentErrorMessage);
                return false;
            }
            case "COLLECTING":
            case "WAITING_REPLENISHMENT": {
                this.showError(
                    _t(
                        "Cashmatic is currently in collection/replenishment mode, please finish this process on the machine before making a payment."
                    )
                );
                return false;
            }
            case "SUCCESS": {
                this.setPaymentInfo(paymentResult);
                return true;
            }
            case "CHANGE_SHORTAGE": {
                this.setPaymentInfo(paymentResult);
                await this.pos.printReceipt({printBillActionTriggered: true});
                const notDispensed = this.env.utils.formatCurrency(
                    this.cashmaticAmountToPosAmount(paymentResult.notDispensed || 0)
                );
                this.showError(
                    _t(
                        "Cashmatic did not disburse all other/amount claimed. Amount not disbursed: %s.",
                        notDispensed
                    )
                );
                return false;
            }
            case "OTHER_OPERATION":
            case "OCCUPIED_BY_OTHER": {
                this.showError(_t("Cashmatic is busy with another operation."));
                return false;
            }
            case "EXCLUSIVE_ERROR": {
                this.showCashmaticCancelDialog(
                    _t(
                        "Cashmatic is busy with another operation. Do you want to cancel it?"
                    )
                );
                return false;
            }
            case "AUTO_RECOVERY_FAILURE": {
                this.showError(
                    _t(
                        "The Cashmatic payment failed due to an unrecoverable error - see Cashmatic screen for details."
                    )
                );
                return false;
            }
            case "CANCEL": {
                return false;
            }
            default: {
                this.showError(
                    _t(
                        "The Cashmatic payment failed for an unknown reason: %s",
                        paymentResult.status
                    )
                );
                return false;
            }
        }
    }

    async sendPaymentCancel() {
        const cancelPromise = new Promise((resolve) => {
            this.cancellationResolver = resolve;
        });
        const cancelResult = await this.cashmaticService.initiatePaymentCancel();

        if (cancelResult === "DISCONNECTED") {
            this.cancellationResolver = null;
            this.showError(_t("Cashmatic is disconnected."));
            return false;
        }

        if (cancelResult === "ERROR") {
            this.cancellationResolver = null;
            this.showError(this.currentErrorMessage);
            return false;
        }

        return await cancelPromise;
    }

    /**
     * @param {{ status: string, cashGiven?: number, cashReturned?: number, transactionId?: string, operation?: string }} paymentResponse
     */
    setPaymentInfo(paymentResponse) {
        const isSuccessful = paymentResponse.status === "SUCCESS";
        const {transactionId, cashGiven, cashReturned} = paymentResponse;
        this.paymentLine.transaction_id = transactionId;
        this.paymentLine.setAmount(this.cashmaticAmountToPosAmount(cashGiven));
        this.paymentLine.setReceiptInfo(
            this.makeReceiptMessage(
                transactionId,
                cashGiven,
                cashReturned,
                isSuccessful,
                paymentResponse.operation
            )
        );
    }

    /**
     * @param {String} transactionId
     * @param {Number} amountDeposited
     * @param {Number} amountReturned
     * @param {Boolean} isSuccessful
     * @param {String} operation
     * @returns {String}
     */
    makeReceiptMessage(
        transactionId,
        amountDeposited,
        amountReturned,
        isSuccessful,
        operation
    ) {
        const isWithdrawal =
            operation === "withdrawal" || Number(amountDeposited || 0) < 0;
        const header = isSuccessful
            ? _t("CASHMATIC TRANSACTION SUCCESSFUL")
            : _t("CASHMATIC TRANSACTION CANCELLED");
        const transactionIdLine = _t("Transaction ID: %s", transactionId || "-");
        const depositedLine = isWithdrawal
            ? _t(
                  "Cash disbursed: %s",
                  this.env.utils.formatCurrency(
                      Math.abs(this.cashmaticAmountToPosAmount(amountDeposited))
                  )
              )
            : _t(
                  "Cash deposited: %s",
                  this.env.utils.formatCurrency(
                      this.cashmaticAmountToPosAmount(amountDeposited)
                  )
              );
        const changeGivenLine = isWithdrawal
            ? ""
            : _t(
                  "Change given: %s",
                  this.env.utils.formatCurrency(
                      this.cashmaticAmountToPosAmount(amountReturned)
                  )
              );

        return `${header}\n${transactionIdLine}\n${depositedLine}\n${changeGivenLine}\n\n`;
    }

    cashmaticAmountToPosAmount(amountInCents) {
        const amount =
            Number(amountInCents || 0) / Math.pow(10, this.pos.currency.decimal_places);
        return this.env.utils.roundCurrency(amount);
    }

    showError(msg, title = _t("Cashmatic error")) {
        this.dialog.add(AlertDialog, {
            title: title,
            body: msg,
        });
    }

    showCashmaticCancelDialog(message) {
        this.dialog.add(CashmaticCancelDialog, {
            message,
            cancel: async () => {
                const cancelStatus =
                    await this.cashmaticService.initiatePaymentCancel();
                if (
                    cancelStatus !== "SUCCESS" &&
                    !["IDLE", "RESETTING"].includes(this.cashmaticService.status)
                ) {
                    await this.cashmaticService.reset();
                }
            },
        });
    }
}
