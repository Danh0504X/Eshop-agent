import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the backend, so the browser talks to one origin.
// Port 5174 lets this app run next to the old demo UI in frontend/ (5173).
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5174,
        proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:4000", changeOrigin: true } },
    },
});
