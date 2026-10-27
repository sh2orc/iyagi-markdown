// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VersionsPanel } from "./VersionsPanel";
import { api } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, isInApp: () => true,
    api: { ...actual.api, snapshotList: vi.fn(), snapshotRead: vi.fn() } };
});

let root: Root | undefined;
let host: HTMLDivElement;
const t = makeT("en");

beforeEach(() => {
  vi.mocked(api.snapshotList).mockReset().mockResolvedValue([{ ts: 1000, size: 3 }, { ts: 2000, size: 3 }]);
  vi.mocked(api.snapshotRead).mockReset().mockImplementation(async (_path, ts) => ts === 2000 ? "new" : "old");
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  vi.restoreAllMocks();
});

async function mountPanel() {
  const io: StoreIO = {
    readDocument: async () => ({ text: "current", meta: { hadBom: false, crlf: false }, mtime: 1, size: 7 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }), saveSession: async () => {},
    setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  await store.openPath("/doc.md");
  const restore = vi.spyOn(store, "restoreVersion").mockResolvedValue(true);
  const onClose = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<VersionsPanel store={store} t={t} onClose={onClose} onRestored={vi.fn()} />);
  });
  return { store, restore, onClose };
}

function restoreButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(".btn-primary")!;
}

describe("버전 선택과 복원", () => {
  it("최신순 목록의 선택 시각과 조회·복원 내용이 일치한다", async () => {
    const { store, restore } = await mountPanel();
    expect(host.querySelector('[role="option"]')?.getAttribute("data-ts")).toBe("2000");
    expect(api.snapshotRead).toHaveBeenLastCalledWith("/doc.md", 2000);
    await act(async () => { restoreButton().click(); });
    expect(restore).toHaveBeenCalledWith(store.active!.id, "/doc.md", store.active!.state.doc, "new");
  });

  it("선택 변경 후 늦게 도착한 이전 조회 결과를 복원하지 않는다", async () => {
    let finishNewest!: (text: string) => void;
    vi.mocked(api.snapshotRead).mockImplementation((_path, ts) => ts === 2000
      ? new Promise<string>((resolve) => { finishNewest = resolve; }) : Promise.resolve("old"));
    const { restore } = await mountPanel();
    expect(restoreButton().disabled).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-ts="1000"]')!.click(); });
    await act(async () => { finishNewest("late new"); });
    await act(async () => { restoreButton().click(); });
    expect(restore.mock.calls[0]?.[3]).toBe("old");
  });

  it("보기 버튼의 Enter는 복원을 실행하지 않는다", async () => {
    const { restore } = await mountPanel();
    act(() => {
      host.querySelector(".versions-viewbtn")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("기록 조회 실패를 빈 기록으로 숨기지 않고 다시 불러온다", async () => {
    vi.mocked(api.snapshotList).mockRejectedValueOnce(new Error("unreadable"));
    await mountPanel();
    expect(host.textContent).toContain(t.versionsLoadFailed);
    expect(host.textContent).not.toContain(t.versionsEmpty);
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    expect(api.snapshotList).toHaveBeenCalledTimes(2);
    expect(restoreButton().disabled).toBe(false);
  });
});
