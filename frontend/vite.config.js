import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import viteCompression from "vite-plugin-compression";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, "../", "");
	return {
		plugins: [
			react(),
			viteCompression({
				algorithm: "gzip",
				ext: ".gz",
			}),
			viteCompression({
				algorithm: "brotliCompress",
				ext: ".br",
			}),
		],
		base: env.BASE_URL,
		resolve: {
			alias: {
				"@": fileURLToPath(new URL("./src", import.meta.url)),
			},
		},
		server: {
			port: 3000,
			open: true,
			proxy: {
				// Proxy API requests during development
				[`${env.BASE_URL}api`]: {
					target: `http://localhost:${env.NGINX_PORT}`,
					changeOrigin: true,
					secure: false,
					// Forward WebSocket upgrades too (recorder streaming relay).
					ws: true,
				},
			},
		},
	};
});
