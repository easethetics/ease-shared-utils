import { defineConfig } from "tsup";

export default defineConfig([
    // ESM + CJS + types for bundlers (Next.js, Vite, webpack) and Node.
    {
        entry: { "jwt-token-manager": "src/jwt-token-manager.ts" },
        format: ["esm", "cjs"],
        dts: true,
        sourcemap: true,
        target: "es2018",
    },
    // Classic <script> build for jsDelivr / Django templates / plain HTML.
    {
        entry: { "jwt-token-manager.global": "src/jwt-token-manager.global.ts" },
        format: ["iife"],
        globalName: "EaseJwt",
        sourcemap: true,
        target: "es2018",
        outExtension: () => ({ js: ".js" }),
    },
    {
        entry: { "jwt-token-manager.global": "src/jwt-token-manager.global.ts" },
        format: ["iife"],
        globalName: "EaseJwt",
        minify: true,
        sourcemap: true,
        target: "es2018",
        outExtension: () => ({ js: ".min.js" }),
    },
]);
