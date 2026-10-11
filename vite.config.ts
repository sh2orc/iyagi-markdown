import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // 형제 프로젝트: iyagi-term 1420, iyagi-layout 1421. 세 앱을 동시에 개발할 수 있게 1422.
    port: 1422,
    strictPort: true,
    watch: { ignored: ["**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // mermaid·KaTeX는 기본 청크에서 분리되어야 한다(§1-2 지연 로딩). rollupOptions는
    // 동적 import를 쓰는 한 자동으로 분리되므로 수동 chunks는 두지 않는다.
  },
});
