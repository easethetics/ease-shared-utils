interface TokenSnapshot {
    token: string;
    wsUrl: string;
    expiresIn: number;
}
/** Shape the backend refresh call must resolve with (snake_case matches the API). */
interface TokenResponse {
    token: string;
    ws_url?: string;
    expires_in?: number;
}
type RefreshCallback = (token: string, expiresIn: number, wsUrl: string) => Promise<TokenResponse> | TokenResponse;
interface TokenManagerOptions {
    ws_url: string;
    token?: string;
    expires_in?: number;
    refreshCallback?: RefreshCallback | null;
}
type TokenListener = (snapshot: TokenSnapshot) => void;
interface ChannelOpenInfo {
    socket: WebSocket;
    originalEvent: Event;
    token: string;
    channel: string;
}
/** Any constructor compatible with the browser WebSocket API. */
type WebSocketConstructor = new (url: string) => WebSocket;
interface ChannelHandlers {
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
interface ChannelClientOptions extends ChannelHandlers {
    channel: string;
}
declare class TokenManager {
    private token;
    private expiresIn;
    private wsUrl;
    private readonly refreshCallback;
    private listeners;
    private refreshPromise;
    private refreshTimer;
    private closed;
    constructor(options: TokenManagerOptions);
    /** Current token. Read-only access for ChannelClient. */
    get currentToken(): string;
    snapshot(): TokenSnapshot;
    subscribe(listener: TokenListener): () => void;
    private _notify;
    private _scheduleRefresh;
    /**
     * Refresh the shared token. Concurrent callers share one in-flight request.
     * Pass the token a channel was using (staleToken): if the manager already
     * holds a newer one, resolve immediately without calling the backend again.
     */
    refresh(staleToken?: string): Promise<TokenSnapshot>;
    close(): void;
    /** Convenience factory: manager.channel("orders", { onMessage: ... }) */
    channel(name: string, handlers?: ChannelHandlers): ChannelClient;
}
declare class ChannelClient {
    private readonly manager;
    private readonly channel;
    private readonly buildUrl;
    private readonly onOpen;
    private readonly onMessage;
    private readonly onClose;
    private readonly onError;
    private readonly unsubscribe;
    private readonly WebSocketImpl;
    /** Which token each socket was opened with. */
    private readonly socketTokens;
    private socket;
    private pendingSocket;
    private reconnectTimer;
    private backoffMs;
    private closed;
    constructor(manager: TokenManager, options: ChannelClientOptions);
    private _open;
    private _tokenOf;
    private _bind;
    private _connect;
    private _rotate;
    private _refreshThenConnect;
    private _retry;
    close(): void;
}

export { ChannelClient, type ChannelClientOptions, type ChannelHandlers, type ChannelOpenInfo, type RefreshCallback, type TokenListener, TokenManager, type TokenManagerOptions, type TokenResponse, type TokenSnapshot, type WebSocketConstructor };
