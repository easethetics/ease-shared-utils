const REFRESH_RETRY_MS = 5000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const DEFAULT_EXPIRES_IN_S = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenSnapshot {
    token: string;
    wsUrl: string;
    expiresIn: number;
}

/** Shape the backend refresh call must resolve with (snake_case matches the API). */
export interface TokenResponse {
    token: string;
    ws_url?: string;
    expires_in?: number;
}

export type RefreshCallback = (
    token: string,
    expiresIn: number,
    wsUrl: string,
) => Promise<TokenResponse> | TokenResponse;

export interface TokenManagerOptions {
    ws_url: string;
    token?: string;
    expires_in?: number;
    refreshCallback?: RefreshCallback | null;
}

export type TokenListener = (snapshot: TokenSnapshot) => void;

export interface ChannelOpenInfo {
    socket: WebSocket;
    originalEvent: Event;
    token: string;
    channel: string;
}

/** Any constructor compatible with the browser WebSocket API. */
export type WebSocketConstructor = new (url: string) => WebSocket;

export interface ChannelHandlers {
    /**
     * WebSocket implementation to use. Defaults to the global `WebSocket`
     * (browsers, React Native, Node 22+). Pass one explicitly in environments
     * without it, e.g. `import WebSocket from "ws"` on older Node.
     */
    webSocketImpl?: WebSocketConstructor;
    buildUrl?: (wsUrl: string, channel: string, token: string) => string;
    onOpen?: (info: ChannelOpenInfo) => void;
    onMessage?: (event: MessageEvent) => void;
    onClose?: (event: CloseEvent) => void;
    onError?: (error: Event | Error) => void;
}

export interface ChannelClientOptions extends ChannelHandlers {
    channel: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withParam(url: string, key: string, value: string): string {
    const separator = url.indexOf("?") === -1 ? "?" : "&";
    return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

function resolveWebSocket(
    impl: WebSocketConstructor | undefined,
): WebSocketConstructor {
    if (impl) return impl;
    if (typeof globalThis !== "undefined" && globalThis.WebSocket) {
        return globalThis.WebSocket;
    }
    throw new Error(
        "No WebSocket implementation found. Open channels in the browser " +
            "(e.g. inside useEffect in Next.js) or pass `webSocketImpl`.",
    );
}

// ---------------------------------------------------------------------------
// TokenManager: owns the token, refreshes it once, notifies subscribers.
// ---------------------------------------------------------------------------

export class TokenManager {
    private token: string;
    private expiresIn: number;
    private wsUrl: string;
    private readonly refreshCallback: RefreshCallback | null;
    private listeners: TokenListener[] = [];
    private refreshPromise: Promise<TokenSnapshot> | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;

    constructor(options: TokenManagerOptions) {
        if (!options || !options.ws_url) {
            throw new Error("ws_url is required");
        }
        this.token = options.token || "";
        this.expiresIn = Number(options.expires_in) || DEFAULT_EXPIRES_IN_S;
        this.wsUrl = options.ws_url;
        this.refreshCallback = options.refreshCallback || null;
        this._scheduleRefresh();
    }

    /** Current token. Read-only access for ChannelClient. */
    get currentToken(): string {
        return this.token;
    }

    snapshot(): TokenSnapshot {
        return {
            token: this.token,
            wsUrl: this.wsUrl,
            expiresIn: this.expiresIn,
        };
    }

    subscribe(listener: TokenListener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    private _notify(): void {
        const snap = this.snapshot();
        this.listeners.slice().forEach((listener) => {
            try {
                listener(snap);
            } catch (err) {
                // A faulty subscriber must not break refresh for the others.
                console.error(err);
            }
        });
    }

    private _scheduleRefresh(delayMs?: number): void {
        clearTimeout(this.refreshTimer);
        if (this.closed || !this.refreshCallback) return;

        const delay =
            typeof delayMs === "number"
                ? delayMs
                : Math.max(100, this.expiresIn * 0.8 * 1000);

        this.refreshTimer = setTimeout(() => {
            this.refresh().catch(() => {
                this._scheduleRefresh(REFRESH_RETRY_MS);
            });
        }, delay);
    }

    /**
     * Refresh the shared token. Concurrent callers share one in-flight request.
     * Pass the token a channel was using (staleToken): if the manager already
     * holds a newer one, resolve immediately without calling the backend again.
     */
    refresh(staleToken?: string): Promise<TokenSnapshot> {
        if (this.closed) {
            return Promise.reject(new Error("token manager closed"));
        }
        if (staleToken && staleToken !== this.token) {
            return Promise.resolve(this.snapshot());
        }

        const callback = this.refreshCallback;
        if (!callback) {
            return Promise.reject(
                new Error("refreshCallback is not configured"),
            );
        }
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = Promise.resolve()
            .then(() => callback(this.token, this.expiresIn, this.wsUrl))
            .then((next) => {
                if (this.closed) throw new Error("token manager closed");
                if (!next || !next.token) {
                    throw new Error("refreshCallback returned no token");
                }
                this.token = next.token;
                this.wsUrl = next.ws_url || this.wsUrl;
                this.expiresIn = Number(next.expires_in) || this.expiresIn;
                this._scheduleRefresh();
                this._notify();
                return this.snapshot();
            })
            .finally(() => {
                this.refreshPromise = null;
            });

        return this.refreshPromise;
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.refreshTimer);
        this.listeners = [];
    }

    /** Convenience factory: manager.channel("orders", { onMessage: ... }) */
    channel(name: string, handlers?: ChannelHandlers): ChannelClient {
        return new ChannelClient(this, { ...handlers, channel: name });
    }
}

// ---------------------------------------------------------------------------
// ChannelClient: one socket per channel, token supplied by the TokenManager.
// ---------------------------------------------------------------------------

export class ChannelClient {
    private readonly manager: TokenManager;
    private readonly channel: string;
    private readonly buildUrl: NonNullable<ChannelHandlers["buildUrl"]>;
    private readonly onOpen: NonNullable<ChannelHandlers["onOpen"]>;
    private readonly onMessage: NonNullable<ChannelHandlers["onMessage"]>;
    private readonly onClose: NonNullable<ChannelHandlers["onClose"]>;
    private readonly onError: NonNullable<ChannelHandlers["onError"]>;
    private readonly unsubscribe: () => void;
    private readonly WebSocketImpl: WebSocketConstructor;
    /** Which token each socket was opened with. */
    private readonly socketTokens = new WeakMap<WebSocket, string>();

    private socket: WebSocket | null = null;
    private pendingSocket: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private backoffMs = INITIAL_BACKOFF_MS;
    private closed = false;

    constructor(manager: TokenManager, options: ChannelClientOptions) {
        if (!manager) throw new Error("token manager is required");
        if (!options || !options.channel)
            throw new Error("channel is required");

        // Fail fast (e.g. during SSR) instead of retrying forever.
        this.WebSocketImpl = resolveWebSocket(options.webSocketImpl);
        this.manager = manager;
        this.channel = options.channel;
        this.buildUrl =
            options.buildUrl ||
            ((wsUrl, channel, token) =>
                withParam(
                    withParam(wsUrl, "channel", channel),
                    "token",
                    token,
                ));
        this.onOpen = options.onOpen || (() => {});
        this.onMessage = options.onMessage || (() => {});
        this.onClose = options.onClose || (() => {});
        this.onError = options.onError || (() => {});

        this.unsubscribe = manager.subscribe(() => {
            this._rotate();
        });
        this._connect();
    }

    private _open(): WebSocket {
        const snap = this.manager.snapshot();
        const socket = new this.WebSocketImpl(
            this.buildUrl(snap.wsUrl, this.channel, snap.token),
        );
        this.socketTokens.set(socket, snap.token);
        return socket;
    }

    private _tokenOf(socket: WebSocket): string {
        return this.socketTokens.get(socket) || "";
    }

    private _bind(socket: WebSocket, pending: boolean): void {
        socket.onopen = (event) => {
            if (this.closed) {
                socket.close();
                return;
            }

            if (pending) {
                if (this.pendingSocket !== socket) {
                    socket.close(); // superseded by a newer rotation
                    return;
                }
                const oldSocket = this.socket;
                this.socket = socket;
                this.pendingSocket = null;
                if (oldSocket && oldSocket !== socket) {
                    try {
                        oldSocket.close();
                    } catch (err) {
                        this.onError(toError(err));
                    }
                }
            } else if (this.socket !== socket) {
                socket.close();
                return;
            }

            this.backoffMs = INITIAL_BACKOFF_MS;
            this.onOpen({
                socket,
                originalEvent: event,
                token: this._tokenOf(socket),
                channel: this.channel,
            });
        };

        socket.onmessage = (event) => {
            if (!this.closed && socket === this.socket) {
                this.onMessage(event);
            }
        };

        socket.onerror = (event) => {
            if (
                !this.closed &&
                (socket === this.socket || socket === this.pendingSocket)
            ) {
                this.onError(event);
            }
        };

        socket.onclose = (event) => {
            if (this.closed) {
                if (socket === this.socket) this.onClose(event);
                return;
            }

            if (pending) {
                // Rotation attempt failed; the active socket keeps serving.
                if (this.pendingSocket === socket) {
                    this.pendingSocket = null;
                    this._retry(() => this._rotate());
                }
                return;
            }

            // Not the active socket anymore (replaced by a rotation).
            if (socket !== this.socket) return;
            this.socket = null;

            // Reconnecting below uses the latest token, so drop any rotation.
            if (this.pendingSocket) {
                const stale = this.pendingSocket;
                this.pendingSocket = null;
                stale.close();
            }

            if (event.code === 4001 && event.reason === "token_expired") {
                this._refreshThenConnect(this._tokenOf(socket));
                return;
            }
            this._retry(() => this._connect());
        };
    }

    private _connect(): void {
        if (this.closed || this.socket) return;
        clearTimeout(this.reconnectTimer);
        try {
            this.socket = this._open();
            this._bind(this.socket, false);
        } catch (err) {
            this.socket = null;
            this.onError(toError(err));
            this._retry(() => this._connect());
        }
    }

    // Token changed centrally: open a replacement socket, swap on open.
    private _rotate(): void {
        if (this.closed || !this.socket) return; // reconnect path will use new token
        if (this._tokenOf(this.socket) === this.manager.currentToken) return;

        if (this.pendingSocket) {
            const stale = this.pendingSocket;
            this.pendingSocket = null;
            stale.close();
        }

        try {
            this.pendingSocket = this._open();
            this._bind(this.pendingSocket, true);
        } catch (err) {
            this.pendingSocket = null;
            this.onError(toError(err));
            this._retry(() => this._rotate());
        }
    }

    private _refreshThenConnect(staleToken: string): void {
        this.manager
            .refresh(staleToken)
            .then(() => {
                if (!this.closed) this._connect();
            })
            .catch(() => {
                if (!this.closed) this._retry(() => this._connect());
            });
    }

    private _retry(fn: () => void): void {
        if (this.closed) return;

        clearTimeout(this.reconnectTimer);
        const delay = Math.min(
            this.backoffMs + Math.random() * 1000,
            MAX_BACKOFF_MS,
        );
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.closed) fn();
        }, delay);
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.reconnectTimer);
        this.unsubscribe();
        try {
            if (this.pendingSocket) this.pendingSocket.close();
            if (this.socket) this.socket.close();
        } catch (err) {
            this.onError(toError(err));
        }
    }
}
