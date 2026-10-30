import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the backend, so the browser talks to one origin.
// Port 5174 lets this app run next to the old demo UI in frontend/ (5173).
// `npm run dev:https` serves on the local network over HTTPS (self-signed): phones only allow the camera on
// HTTPS, while localhost on the computer works with plain `npm run dev`.
export default defineConfig(({ mode }) => {
    const https = mode === "https";
    return {
        plugins: [react(), ...(https ? [basicSsl()] : [])],
        server: {
            port: 5174,
            host: https ? true : undefined,
            proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:4000", changeOrigin: true } },
        },
    };
});
