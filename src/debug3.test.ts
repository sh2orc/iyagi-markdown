// @vitest-environment jsdom
import { describe, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { createDocState } from "./editor/cm";
import { setPreviewConfig, __testing } from "./editor/livePreview";
import { readFileSync } from "node:fs";

const SAMPLE = readFileSync(process.cwd() + "/docs/sample.md", "utf8");

describe("debug3", () => {
  it("decorationField 값 직접 관찰", async () => {
    for (const mode of ["read", "edit"] as const) {
      const values: number[] = [];
      const view = new EditorView({
        state: createDocState(SAMPLE, mode),
        parent: document.body,
      });
      // 필드 값 관찰: 업데이트 리스너로 크기 기록.
      view.dispatch({
        effects: setPreviewConfig.of({ baseDir: "/tmp", remoteImages: true, showImages: true, theme: "light" }),
      });
      const timer = setInterval(() => {
        values.push((view.state.field(__testing.decorationField, false) as unknown as { size: number })?.size ?? -1);
      }, 60);
      await new Promise((r) => setTimeout(r, 400));
      clearInterval(timer);
      console.log(`mode=${mode} field sizes over time:`, values.join(","));
      view.destroy();
      document.body.innerHTML = "";
    }
  });
});
