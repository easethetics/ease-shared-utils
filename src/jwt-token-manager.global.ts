/**
 * Entry for the IIFE / <script> build (jsDelivr). It is the only file that
 * touches globals, so ESM/CJS imports (Next.js, bundlers, SSR) stay
 * side-effect free.
 *
 * Exposes:
 *   window.EaseJwt.TokenManager / window.EaseJwt.ChannelClient  (via tsup globalName)
 *   window.JwtTokenManager / window.JwtChannelClient            (short aliases)
 */
import { ChannelClient, TokenManager } from "./jwt-token-manager.ts";

export * from "./jwt-token-manager.ts";

declare global {
    // eslint-disable-next-line no-var
    var JwtTokenManager: typeof TokenManager;
    // eslint-disable-next-line no-var
    var JwtChannelClient: typeof ChannelClient;
}

globalThis.JwtTokenManager = TokenManager;
globalThis.JwtChannelClient = ChannelClient;
