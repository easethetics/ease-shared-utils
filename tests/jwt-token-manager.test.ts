import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import {
    ChannelClient,
    TokenManager,
    type WebSocketConstructor,
} from "../src/jwt-token-manager.ts";

// Minimal stand-in for the browser WebSocket.
class FakeSocket {
    static instances: FakeSocket[] = [];
    url: string;
    closed = false;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }
    open() {
        this.onopen?.({ type: "open" });
    }
    message(data: unknown) {
        this.onmessage?.({ data });
    }
    serverClose(code = 1006, reason = "") {
        this.closed = true;
        this.onclose?.({ code, reason });
    }
    close() {
        this.closed = true;
    }
}
const FakeWS = FakeSocket as unknown as WebSocketConstructor;
const flush = () => new Promise((r) => setImmediate(r));
const tokenOf = (s: FakeSocket) => new URL(s.url).searchParams.get("token");

beforeEach(() => {
    FakeSocket.instances = [];
});

describe("module", () => {
    test("importing the core module does not create globals", () => {
        assert.equal("JwtTokenManager" in globalThis, false);
        assert.equal("JwtChannelClient" in globalThis, false);
    });

    test("the global entry exposes the script-tag globals", async () => {
        const mod = await import("../src/jwt-token-manager.global.ts");
        assert.equal(globalThis.JwtTokenManager, mod.TokenManager);
        assert.equal(globalThis.JwtChannelClient, mod.ChannelClient);
    });
});

describe("TokenManager", () => {
    test("requires ws_url", () => {
        assert.throws(
            () => new TokenManager({} as never),
            /ws_url is required/,
        );
    });

    test("concurrent refreshes share one backend call", async () => {
        const cb = mock.fn(async () => ({ token: "t2", expires_in: 60 }));
        const m = new TokenManager({
            ws_url: "wss://x/ws",
            token: "t1",
            refreshCallback: cb,
        });
        const [a, b] = await Promise.all([m.refresh(), m.refresh()]);
        assert.equal(cb.mock.callCount(), 1);
        assert.equal(a.token, "t2");
        assert.equal(b.token, "t2");
        m.close();
    });

    test("refresh with a stale token skips the backend", async () => {
        const cb = mock.fn(async () => ({ token: "t3" }));
        const m = new TokenManager({
            ws_url: "wss://x/ws",
            token: "t2",
            refreshCallback: cb,
        });
        const snap = await m.refresh("t1");
        assert.equal(snap.token, "t2");
        assert.equal(cb.mock.callCount(), 0);
        m.close();
    });
});

describe("ChannelClient", () => {
    let realWS: unknown;
    beforeEach(() => {
        realWS = globalThis.WebSocket;
    });
    afterEach(() => {
        (globalThis as Record<string, unknown>).WebSocket = realWS;
    });

    test("throws a clear error when no WebSocket exists (SSR)", () => {
        delete (globalThis as Record<string, unknown>).WebSocket;
        const m = new TokenManager({ ws_url: "wss://x/ws", token: "t1" });
        assert.throws(() => m.channel("orders"), /No WebSocket implementation/);
        m.close();
    });

    test("falls back to the global WebSocket", () => {
        (globalThis as Record<string, unknown>).WebSocket = FakeWS;
        const m = new TokenManager({ ws_url: "wss://x/ws", token: "t1" });
        const c = m.channel("orders");
        assert.equal(FakeSocket.instances.length, 1);
        c.close();
        m.close();
    });

    test("connects with channel + token and delivers messages", () => {
        const m = new TokenManager({ ws_url: "wss://x/ws", token: "t1" });
        const onOpen = mock.fn();
        const onMessage = mock.fn();
        const c = new ChannelClient(m, {
            channel: "orders",
            webSocketImpl: FakeWS,
            onOpen,
            onMessage,
        });
        const s = FakeSocket.instances[0];
        assert.equal(s.url, "wss://x/ws?channel=orders&token=t1");
        s.open();
        s.message("hi");
        assert.equal(onOpen.mock.calls[0].arguments[0].token, "t1");
        assert.deepEqual(onMessage.mock.calls[0].arguments[0], { data: "hi" });
        c.close();
        m.close();
    });

    test("rotates to a new socket after a token refresh", async () => {
        const m = new TokenManager({
            ws_url: "wss://x/ws",
            token: "t1",
            refreshCallback: async () => ({ token: "t2" }),
        });
        const c = m.channel("orders", { webSocketImpl: FakeWS });
        const first = FakeSocket.instances[0];
        first.open();

        await m.refresh();
        const second = FakeSocket.instances[1];
        assert.equal(tokenOf(second), "t2");
        assert.equal(first.closed, false, "old socket serves until swap");

        second.open();
        assert.equal(first.closed, true);
        c.close();
        m.close();
    });

    test("refreshes and reconnects on 4001 token_expired", async () => {
        const cb = mock.fn(async () => ({ token: "t2" }));
        const m = new TokenManager({
            ws_url: "wss://x/ws",
            token: "t1",
            refreshCallback: cb,
        });
        const c = m.channel("orders", { webSocketImpl: FakeWS });
        const first = FakeSocket.instances[0];
        first.open();
        first.serverClose(4001, "token_expired");
        await flush();
        await flush();

        assert.equal(cb.mock.callCount(), 1);
        const latest = FakeSocket.instances[FakeSocket.instances.length - 1];
        assert.equal(tokenOf(latest), "t2");
        c.close();
        m.close();
    });

    test("close() stops further messages", () => {
        const m = new TokenManager({ ws_url: "wss://x/ws", token: "t1" });
        const onMessage = mock.fn();
        const c = m.channel("orders", { webSocketImpl: FakeWS, onMessage });
        const s = FakeSocket.instances[0];
        s.open();
        c.close();
        s.message("late");
        assert.equal(onMessage.mock.callCount(), 0);
        assert.equal(s.closed, true);
        m.close();
    });
});
