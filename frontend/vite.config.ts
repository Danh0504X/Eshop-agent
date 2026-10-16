import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the backend, so the browser talks to one origin.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:4000", changeOrigin: true } },
    },
});
