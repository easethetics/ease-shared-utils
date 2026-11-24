// src/jwt-token-manager.ts
var REFRESH_RETRY_MS = 5e3;
var INITIAL_BACKOFF_MS = 1e3;
var MAX_BACKOFF_MS = 3e4;
var DEFAULT_EXPIRES_IN_S = 300;
function withParam(url, key, value) {
  const separator = url.indexOf("?") === -1 ? "?" : "&";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}
function resolveWebSocket(impl) {
  if (impl) return impl;
  if (typeof globalThis !== "undefined" && globalThis.WebSocket) {
    return globalThis.WebSocket;
  }
  throw new Error(
    "No WebSocket implementation found. Open channels in the browser (e.g. inside useEffect in Next.js) or pass `webSocketImpl`."
  );
}
var TokenManager = class {
  constructor(options) {
    this.listeners = [];
    this.refreshPromise = null;
    this.closed = false;
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
  get currentToken() {
    return this.token;
  }
  snapshot() {
    return {
      token: this.token,
      wsUrl: this.wsUrl,
      expiresIn: this.expiresIn
    };
  }
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  _notify() {
    const snap = this.snapshot();
    this.listeners.slice().forEach((listener) => {
      try {
        listener(snap);
      } catch (err) {
        console.error(err);
      }
    });
  }
  _scheduleRefresh(delayMs) {
    clearTimeout(this.refreshTimer);
    if (this.closed || !this.refreshCallback) return;
    const delay = typeof delayMs === "number" ? delayMs : Math.max(100, this.expiresIn * 0.8 * 1e3);
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
  refresh(staleToken) {
    if (this.closed) {
      return Promise.reject(new Error("token manager closed"));
    }
    if (staleToken && staleToken !== this.token) {
      return Promise.resolve(this.snapshot());
    }
    const callback = this.refreshCallback;
    if (!callback) {
      return Promise.reject(
        new Error("refreshCallback is not configured")
      );
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.resolve().then(() => callback(this.token, this.expiresIn, this.wsUrl)).then((next) => {
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
    }).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  close() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    this.listeners = [];
  }
  /** Convenience factory: manager.channel("orders", { onMessage: ... }) */
  channel(name, handlers) {
    return new ChannelClient(this, { ...handlers, channel: name });
  }
};
var ChannelClient = class {
  constructor(manager, options) {
    /** Which token each socket was opened with. */
    this.socketTokens = /* @__PURE__ */ new WeakMap();
    this.socket = null;
    this.pendingSocket = null;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.closed = false;
    if (!manager) throw new Error("token manager is required");
    if (!options || !options.channel)
      throw new Error("channel is required");
    this.WebSocketImpl = resolveWebSocket(options.webSocketImpl);
    this.manager = manager;
    this.channel = options.channel;
    this.buildUrl = options.buildUrl || ((wsUrl, channel, token) => withParam(
      withParam(wsUrl, "channel", channel),
      "token",
      token
    ));
    this.onOpen = options.onOpen || (() => {
    });
    this.onMessage = options.onMessage || (() => {
    });
    this.onClose = options.onClose || (() => {
    });
    this.onError = options.onError || (() => {
    });
    this.unsubscribe = manager.subscribe(() => {
      this._rotate();
    });
    this._connect();
  }
  _open() {
    const snap = this.manager.snapshot();
    const socket = new this.WebSocketImpl(
      this.buildUrl(snap.wsUrl, this.channel, snap.token)
    );
    this.socketTokens.set(socket, snap.token);
    return socket;
  }
  _tokenOf(socket) {
    return this.socketTokens.get(socket) || "";
  }
  _bind(socket, pending) {
    socket.onopen = (event) => {
      if (this.closed) {
        socket.close();
        return;
      }
      if (pending) {
        if (this.pendingSocket !== socket) {
          socket.close();
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
        channel: this.channel
      });
    };
    socket.onmessage = (event) => {
      if (!this.closed && socket === this.socket) {
        this.onMessage(event);
      }
    };
    socket.onerror = (event) => {
      if (!this.closed && (socket === this.socket || socket === this.pendingSocket)) {
        this.onError(event);
      }
    };
    socket.onclose = (event) => {
      if (this.closed) {
        if (socket === this.socket) this.onClose(event);
        return;
      }
      if (pending) {
        if (this.pendingSocket === socket) {
          this.pendingSocket = null;
          this._retry(() => this._rotate());
        }
        return;
      }
      if (socket !== this.socket) return;
      this.socket = null;
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
  _connect() {
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
  _rotate() {
    if (this.closed || !this.socket) return;
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
  _refreshThenConnect(staleToken) {
    this.manager.refresh(staleToken).then(() => {
      if (!this.closed) this._connect();
    }).catch(() => {
      if (!this.closed) this._retry(() => this._connect());
    });
  }
  _retry(fn) {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      this.backoffMs + Math.random() * 1e3,
      MAX_BACKOFF_MS
    );
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      if (!this.closed) fn();
    }, delay);
  }
  close() {
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
};
export {
  ChannelClient,
  TokenManager
};
//# sourceMappingURL=jwt-token-manager.js.map