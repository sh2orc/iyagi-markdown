import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // 53차 인프라 복원 — jsdom 미구현 API의 전역 no-op 스텁(scrollIntoView 등).
    // 스텁은 window 없는 node 환경 파일에 무해하게 스킵된다.
    setupFiles: ["src/test-setup.ts"],
  },
});
