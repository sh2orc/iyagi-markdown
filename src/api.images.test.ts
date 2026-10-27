// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, initBridge } from "./api";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "/문서/assets/paste.png") }));
const original = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
afterEach(() => {
  if (original) Object.defineProperty(window, "__TAURI_INTERNALS__", original);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  initBridge();
  vi.clearAllMocks();
});
it("sends image bytes as a raw body with an encoded Unicode directory header", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  initBridge();
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const dir = "/문서/100% #폴더";
  await api.saveImageBytes(dir, "image/png", bytes);
  expect(invoke).toHaveBeenCalledWith("save_image_bytes", bytes, {
    headers: { "x-image-directory": encodeURIComponent(dir), "x-image-type": "image/png" },
  });
});
