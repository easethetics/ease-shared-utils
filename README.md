# ease-shared-utils

Shared utilities for Easethetics apps. Each utility ships in three builds:

| Build | File | Use from |
|---|---|---|
| IIFE (`<script>`) | `dist/<name>.global.min.js` | Plain HTML, Django templates, Flutter Web, WebViews (via jsDelivr) |
| ESM | `dist/<name>.js` | Next.js, Vite, webpack, React Native |
| CJS | `dist/<name>.cjs` | Node / older tooling |

TypeScript types (`.d.ts` / `.d.cts`) are included.

## Utilities

### `jwt-token-manager`

One `TokenManager` owns a JWT, refreshes it before expiry (and on `4001 token_expired`), and shares it with any number of `ChannelClient` WebSockets. When the token changes, each channel opens a replacement socket and swaps over only once it is connected, so there is no gap in messages.

#### Plain HTML / Django templates (jsDelivr)

```html
<script src="https://cdn.jsdelivr.net/gh/easethetics/ease-shared-utils@v0.1.0/dist/jwt-token-manager.global.min.js"></script>
<script>
  // Also available as window.EaseJwt.TokenManager
  const manager = new JwtTokenManager({
    ws_url: "{{ ws_url }}",
    token: "{{ ws_token }}",
    expires_in: 300,
    refreshCallback: async () => {
      const res = await fetch("/api/ws-token/", { credentials: "same-origin" });
      return res.json(); // { token, ws_url?, expires_in? }
    },
  });

  const orders = manager.channel("orders", {
    onMessage: (e) => console.log(JSON.parse(e.data)),
  });
</script>
```

Always pin a version (`@v0.1.0`) in production. jsDelivr caches `@latest`/branch URLs for up to 7 days.

#### Next.js (and other bundlers)

```ts
import { TokenManager } from "@easethetics/shared-utils/jwt-token-manager";
```

The module has no side effects on import, so importing it from a Server Component or during SSR is safe. Create the manager and its channels on the client, because they start timers and open sockets:

```tsx
"use client";
import { useEffect } from "react";
import { TokenManager } from "@easethetics/shared-utils/jwt-token-manager";

export function useOrdersChannel(initial: { token: string; ws_url: string }) {
  useEffect(() => {
    const manager = new TokenManager({
      ...initial,
      refreshCallback: () => fetch("/api/ws-token").then((r) => r.json()),
    });
    const channel = manager.channel("orders", {
      onMessage: (e) => console.log(e.data),
    });
    return () => {
      channel.close();
      manager.close();
    };
  }, [initial.token, initial.ws_url]);
}
```

If you create a channel where no `WebSocket` exists (SSR, older Node), it throws a clear error instead of quietly retrying forever. To use it in Node anyway, pass `webSocketImpl`, for example `import WebSocket from "ws"`.

#### React Native

Use the ESM import shown above. React Native provides a global `WebSocket`, so nothing else is needed.

#### Flutter

- **Flutter Web**: load the `<script>` tag in `web/index.html`, then call `JwtTokenManager` through `dart:js_interop`. Your `refreshCallback` should return a JS Promise (`future.toJS`).
- **WebView screens** (`webview_flutter`): the page inside the WebView uses the `<script>` build exactly like plain HTML.
- **Native Flutter (Android/iOS)** cannot run JavaScript modules. It needs a Dart port of `TokenManager`/`ChannelClient` that keeps the same backend contract (`{ token, ws_url, expires_in }`, close code `4001 token_expired`).

## Development

Requires Node 22.6+ (tests run `.ts` files directly with Node's built-in type stripping).

```sh
pnpm i
pnpm test        # node --test, no build needed
pnpm typecheck
pnpm build       # writes dist/
```

### Releasing for jsDelivr

- **From GitHub** (`cdn.jsdelivr.net/gh/...`): the repo must be **public**. Commit `dist/` and push a tag such as `v0.1.0`.
- **From npm** (`cdn.jsdelivr.net/npm/@easethetics/shared-utils@0.1.0/dist/...`): run `npm publish`. `dist/` does not need to be committed.

### Adding a new utility

1. Add `src/<name>.ts`. It must have no side effects on import.
2. If it needs `<script>` globals, add `src/<name>.global.ts`.
3. Add entries to `tsup.config.ts` and `package.json#exports`.
4. Add `tests/<name>.test.ts`.
