import {Logger} from "@bus/workers/bus_worker_utils";
import {_t} from "@web/core/l10n/translation";
import {reactive} from "@odoo/owl";
import {sortBy} from "@web/core/utils/arrays";

const DEFAULT_CASHMATIC_API_URL = "https://127.0.0.1:50301";
const DEFAULT_PAYMENT_TIMEOUT = 120;
const DEFAULT_POLLING_INTERVAL = 350;
const REQUEST_TIMEOUT_MS = 15000;
const IDLE_OPERATION = "idle";
const TOKEN_RENEW_AFTER_MS = 12 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeInteger = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeBaseUrl = (url, fallback = DEFAULT_CASHMATIC_API_URL) => {
    const value = String(url || fallback).trim();
    return value.endsWith("/") ? value.slice(0, -1) : value;
};

const statusFromErrorCode = (errorCode) => {
    const code = Number(errorCode || 0);
    switch (code) {
        case 0:
            return null;
        case 4:
            return "OTHER_OPERATION";
        case 7:
            return "BAD_CREDENTIALS";
        case 13:
            return "DEVICE_NOT_ACTIVE";
        case 18:
            return "CASH_FUND_LOW";
        default:
            return "ERROR";
    }
};

// eslint-disable-next-line complexity
const getStatusFromDeviceInfo = (deviceInfo) => {
    if (!deviceInfo) {
        return "DISCONNECTED";
    }
    const errorStatus = statusFromErrorCode(deviceInfo?.data?.errorCode);
    if (errorStatus) {
        return errorStatus;
    }
    if (
        deviceInfo?.data?.functionalityCode &&
        Number(deviceInfo?.data?.functionalityCode) !== 0
    ) {
        return "ERROR";
    }
    if (
        deviceInfo?.data?.statusMessage &&
        typeof deviceInfo?.data?.statusMessage === "string"
    ) {
        return String(deviceInfo?.data?.statusMessage).toUpperCase();
    }
    return "IDLE";
};

const normalizeDenominationStatus = (item) => {
    const level = Number(item.level ?? 0);
    const floatLevel = Number(item.floatLevel ?? 0);
    const maxLevel = Number(item.maxLevel ?? 0);
    if (maxLevel > 0 && level >= maxLevel) {
        return "FULL";
    }
    if (maxLevel > 0 && level >= maxLevel * 0.9) {
        return "NEAR_FULL";
    }
    if (level <= 0) {
        return "EMPTY";
    }
    if (floatLevel > 0 && level <= floatLevel * 0.25) {
        return "NEAR_EMPTY";
    }
    return "EXIST";
};

const normalizeInventory = (inventory) => {
    const items = Array.isArray(inventory) ? inventory : inventory?.data || [];
    return sortBy(
        items.map((item) => ({
            value: Number(item.value ?? 0),
            amount: Number(item.level ?? 0),
            status: normalizeDenominationStatus(item),
            type: item.type,
            routing: item.routing,
            currency: item.currency,
        })),
        "value"
    );
};

const extractToken = (response) => {
    if (!response) {
        return null;
    }
    if (typeof response === "string") {
        return response;
    }
    return response?.data?.token || null;
};

const formatCashmaticError = (error) => {
    if (!error) {
        return _t("Unknown Cashmatic Error");
    }
    if (error.name === "AbortError") {
        return _t("Communication timeout with Cashmatic");
    }
    if (error.name === "TypeError" || /failed to fetch/i.test(error.message || "")) {
        return _t(
            "The browser blocked the direct call to Cashmatic. " +
                "Verify CORS, local and reachable HTTPS certificate of " +
                "https://127.0.0.1:50301."
        );
    }
    return error.message || error.errorMessage || error.error || String(error);
};

export class CashmaticService {
    /**
     * @param {(status: string) => void} onStatusChange
     */
    constructor(onStatusChange) {
        this.setup(onStatusChange);
    }

    /**
     * @param {(status: string) => void} onStatusChange
     */
    setup(onStatusChange) {
        this.logger = new Logger("pos_cashmatic_connector");
        this.onStatusChange = onStatusChange;
        this._resetState();
    }

    /**
     * In no-bridge mode this URL is the real Cashmatic REST URL.
     * @param {String} apiUrl
     * @param {String} [username]
     * @param {String} [password]
     * @param {{ paymentTimeout?: number, pollingInterval?: number }} [options]
     */
    async connect(apiUrl, username, password, options = {}) {
        this.apiUrl = normalizeBaseUrl(apiUrl || options.cashmaticApiUrl);
        this.username = username;
        this.password = password;
        this.options = {
            paymentTimeout: normalizeInteger(
                options.paymentTimeout,
                DEFAULT_PAYMENT_TIMEOUT
            ),
            pollingInterval: normalizeInteger(
                options.pollingInterval,
                DEFAULT_POLLING_INTERVAL
            ),
        };
        this.status = "CONNECTING";

        try {
            await this._ensureToken();
            await this.refreshDeviceInfo();
        } catch (error) {
            this._handleConnectionError(error);
        }
    }

    get status() {
        return this.state.status;
    }

    set status(newStatus) {
        if (!newStatus || newStatus === this.state.status) {
            return;
        }
        this.state.status = newStatus;
        this.onStatusChange(newStatus);
    }

    async refreshDeviceInfo() {
        try {
            const deviceInfo = await this._request("/api/device/GetDeviceInfo");
            this.state.lastDeviceError =
                deviceInfo?.data?.errorMessage || deviceInfo?.message || null;
            this.status = getStatusFromDeviceInfo(deviceInfo);
            await this.refreshInventory();
            return deviceInfo;
        } catch (error) {
            this._handleConnectionError(error);
            throw error;
        }
    }

    async refreshInventory() {
        try {
            const response = await this._request("/api/device/AllLevels");
            this.state.inventory = normalizeInventory(response);
            return this.state.inventory;
        } catch (error) {
            this._log(
                `Unable to read Cashmatic levels: ${formatCashmaticError(error)}`
            );
        }
    }

    async reset() {
        // Cashmatic exposes reboot/poweroff endpoints, but they are intentionally
        // not triggered from POS/backoffice buttons.
        await this.refreshDeviceInfo();
        return "SUCCESS";
    }

    /**
     * @param {Number} amountInCents
     * @returns {Promise<{ status: string, cashGiven?: number, cashReturned?: number, transactionId?: string, notDispensed?: number, raw?: Object, operation?: string }>}
     */
    async sendPaymentRequest(amountInCents) {
        if (
            [
                "DISCONNECTED",
                "BAD_CREDENTIALS",
                "ERROR",
                "DEVICE_NOT_ACTIVE",
                "CASH_FUND_LOW",
            ].includes(this.status)
        ) {
            this._log(`ErrorPayment: ${this.status}`);
            return {status: this.status};
        }

        if (Number(amountInCents) <= 0) {
            this.state.lastDeviceError = _t("Invalid Cashmatic amount");
            this._log(`ErrorPayment: ${this.state.lastDeviceError}`);
            return {status: "ERROR", raw: {message: this.state.lastDeviceError}};
        }

        this.state.amountInserted = 0;
        this.state.activeTransaction = null;
        this.paymentInProgress = true;
        this.status = "STARTING_PAYMENT";

        try {
            const timeoutSeconds = this.options.paymentTimeout;
            await this._request(
                "/api/transaction/StartPayment",
                {
                    amount: amountInCents,
                    queueAllowed: true,
                    timeout: timeoutSeconds,
                },
                {timeoutMs: REQUEST_TIMEOUT_MS}
            );

            const activeTransaction = await this._pollPaymentEnd();
            const lastTransaction = await this._request("/api/device/LastTransaction");
            await this.refreshInventory();
            const result = this._mapPaymentResult(
                lastTransaction || activeTransaction,
                amountInCents
            );
            this.status = result.status === "SUCCESS" ? "IDLE" : result.status;
            this.paymentInProgress = false;
            this._log(`SuccessPayment: ${amountInCents}`);
            return result;
        } catch (error) {
            this.paymentInProgress = false;
            this.state.lastDeviceError = formatCashmaticError(error);
            this.status = "ERROR";
            this._log(`ErrorPayment: ${this.state.lastDeviceError}`);
            return {status: "ERROR", raw: {message: this.state.lastDeviceError}};
        }
    }

    async initiatePaymentCancel() {
        if (this.status === "DISCONNECTED") {
            return "DISCONNECTED";
        }
        try {
            this.status = "CANCELLING";
            await this._request("/api/transaction/CancelPayment");
            return "SUCCESS";
        } catch (error) {
            this.state.lastDeviceError = formatCashmaticError(error);
            this.status = "ERROR";
            return "ERROR";
        }
    }

    _resetState() {
        this.apiUrl = DEFAULT_CASHMATIC_API_URL;
        this.username = null;
        this.password = null;
        this.token = null;
        this.tokenDate = null;
        this.options = {
            paymentTimeout: DEFAULT_PAYMENT_TIMEOUT,
            pollingInterval: DEFAULT_POLLING_INTERVAL,
        };
        this.paymentInProgress = false;
        this.state = reactive({
            status: "DISCONNECTED",
            inventory: [],
            amountInserted: 0,
            lastDeviceError: null,
            activeTransaction: null,
        });
    }

    async _ensureToken() {
        if (!this.token) {
            await this._login();
            return;
        }

        const tokenAge = Date.now() - (this.tokenDate?.getTime() || 0);
        if (tokenAge < TOKEN_RENEW_AFTER_MS) {
            return;
        }

        try {
            const response = await this._rawRequest("/api/user/RenewToken", {}, true, {
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
            const newToken = extractToken(response);
            if (newToken) {
                this.token = newToken;
            }
            this.tokenDate = new Date();
        } catch {
            this.token = null;
            await this._login();
        }
    }

    async _login() {
        try {
            const response = await this._rawRequest(
                "/api/user/Login",
                {
                    username: this.username,
                    password: this.password,
                },
                false,
                {timeoutMs: REQUEST_TIMEOUT_MS}
            );
            const token = extractToken(response);
            if (!token) {
                throw new Error(_t("Cashmatic token not present in login response"));
            }
            this.token = token;
            this.tokenDate = new Date();
        } catch (error) {
            if (error.httpStatus === 401 || error.httpStatus === 403) {
                this.status = "BAD_CREDENTIALS";
            }
            throw error;
        }
    }

    async _request(path, body = {}, options = {}) {
        await this._ensureToken();
        try {
            return await this._rawRequest(path, body, true, options);
        } catch (error) {
            if (error.httpStatus === 401 || error.httpStatus === 403) {
                this.token = null;
                await this._login();
                return await this._rawRequest(path, body, true, options);
            }
            throw error;
        }
    }

    // eslint-disable-next-line complexity
    async _rawRequest(path, body = {}, authenticated = true, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            options.timeoutMs || REQUEST_TIMEOUT_MS
        );
        const headers = {"Content-Type": "application/json"};
        if (authenticated && this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        try {
            const response = await fetch(`${this.apiUrl}${path}`, {
                method: "POST",
                headers,
                body:
                    body === undefined || body === null
                        ? undefined
                        : JSON.stringify(body),
                signal: controller.signal,
            });
            const data = await response.json();

            if (!response.ok) {
                const message = data?.message || response.statusText;
                const error = new Error(message);
                error.httpStatus = response.status;
                error.payload = data;
                throw error;
            }

            const errorCode = Number(data?.data?.errorCode || data?.code || 0);
            if (errorCode) {
                const error = new Error(
                    data?.data?.errorMessage ||
                        data?.message ||
                        `Cashmatic error ${errorCode}`
                );
                error.errorCode = errorCode;
                error.status = statusFromErrorCode(errorCode);
                error.payload = data;
                throw error;
            }

            return data || {};
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async _pollPaymentEnd() {
        const maxLoops =
            Math.ceil(
                (this.options.paymentTimeout * 1000) / this.options.pollingInterval
            ) + 60;
        let activeTransaction = null;
        for (let i = 0; i < maxLoops; i++) {
            activeTransaction = await this._request("/api/device/ActiveTransaction");
            this.state.activeTransaction = activeTransaction;
            this.state.amountInserted = Number(activeTransaction?.data?.inserted || 0);
            this._mapActiveStatus(activeTransaction);

            if (
                String(activeTransaction?.data?.operation || "").toLowerCase() ===
                IDLE_OPERATION
            ) {
                return activeTransaction;
            }
            await sleep(this.options.pollingInterval);
        }
        throw new Error(_t("Timeout while waiting for Cashmatic response"));
    }

    _mapActiveStatus(transaction) {
        const operation = String(transaction?.data?.operation || "").toLowerCase();
        if (operation === IDLE_OPERATION) {
            this.status = "IDLE";
            return;
        }
        if (operation.includes("dispense")) {
            this.status = "DISPENSING";
            return;
        }
        if (operation.includes("payment") || operation.includes("deposit")) {
            this.status = "WAITING_PAYMENT";
            return;
        }
        if (Number(transaction?.data?.inserted || 0) > 0) {
            this.status = "COUNTING";
            return;
        }
        this.status = "WAITING_PAYMENT";
    }

    // eslint-disable-next-line complexity
    _mapPaymentResult(transaction, requestedAmount) {
        const end = String(transaction?.data?.end || "normal").toLowerCase();
        const notDispensed = Number(transaction?.data?.notDispensed || 0);
        const requested = Number(transaction?.data?.inserted ?? requestedAmount ?? 0);
        const dispensed = Number(transaction?.data?.dispensed ?? 0);
        const operation = transaction?.data?.operation;
        const transactionId = transaction?.data?.id || "";

        let status = "SUCCESS";
        if (["cancel", "canceled", "cancelled", "aborted"].includes(end)) {
            status = "CANCEL";
        } else if (["stopped", "error", "failed", "ko"].includes(end)) {
            status = "ERROR";
        } else if (notDispensed > 0) {
            status = "CHANGE_SHORTAGE";
        }

        return {
            status,
            cashGiven: requested,
            cashReturned: dispensed,
            transactionId,
            notDispensed,
            operation,
            raw: transaction,
        };
    }

    _handleConnectionError(error) {
        const message = formatCashmaticError(error);
        this.state.lastDeviceError = message;
        if (
            error?.status === "BAD_CREDENTIALS" ||
            error?.httpStatus === 401 ||
            error?.httpStatus === 403
        ) {
            this.status = "BAD_CREDENTIALS";
        } else if (error?.status) {
            this.status = error.status;
        } else {
            this.status = "DISCONNECTED";
        }
        this._log(`ConnectionError: ${message}`);
    }

    _log(message) {
        let timestamp = new Date().toISOString();

        if (typeof luxon !== "undefined") {
            timestamp = luxon.DateTime.now().toFormat("yyyy-LL-dd HH:mm:ss");
        }

        const line = `${timestamp} ${message}`;

        if (this.logger?.log) {
            this.logger.log(line);
        } else {
            console.warn(line);
        }
    }
}
