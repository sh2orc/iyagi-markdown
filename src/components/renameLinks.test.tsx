// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type ReplacementReport } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import * as bridge from "../api";
import { Sidebar } from "./Sidebar";
import { GraphView } from "./GraphView";
import { RenameLinksReview } from "./RenameLinksReview";

const t = makeT("en");
const target = { id: 41, ready: true, error: null, root: "/old", from: "/old/before.md", to: "/old/after.md" };
const preview = { id: 7, files: [{ path: "/old/ref.md", count: 1, before: "[[before]]", after: "[[after]]" }], skipped: [] };
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined; host?.remove(); vi.restoreAllMocks();
});
function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}
async function mount() {
  vi.spyOn(api, "finishRenameReview").mockResolvedValue(undefined);
  const io: StoreIO = {
    readDocument: async () => ({ text: "[[before]]", meta: { hadBom: false, crlf: false }, mtime: 1, size: 10 }),
    writeDocument: async () => ({ mtime: 2, size: 10 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  store.state.workspace = "/different-workspace";
  const close = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<RenameLinksReview store={store} target={target} t={t} onClose={close} />); });
  return { store, close };
}

describe("이름 변경 후 링크 검토", () => {
  it("이름 변경한 폴더를 고정하고 검토를 적용하기 전에는 쓰지 않는다", async () => {
    const prepare = vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
    const apply = vi.spyOn(api, "applyReplacement").mockResolvedValue({ applied: [], failed: [] });
    const { close } = await mount();
    expect(prepare).toHaveBeenCalledWith(target.id);
    expect(apply).not.toHaveBeenCalled();
    expect(host.textContent).toContain("[[before]]");
    await act(async () => button(t.close).click());
    expect(close).toHaveBeenCalledWith(false); // 사이드바에서 다시 검토 가능.
  });

  it("적용 경계에서 미저장 상태를 확인한다", async () => {
    vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
    const apply = vi.spyOn(api, "applyReplacement").mockResolvedValue({ applied: [], failed: [] });
    const { store } = await mount();
    // 마지막 렌더 이후 상태 변경도 제출 함수가 다시 읽는다.
    store.newTabWithContent("new draft");
    store.active!.path = "/old/ref.md";
    store.active!.dirty = true;
    await act(async () => button(t.wsApply).click());
    expect(apply).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.renameLinksBlocked);
  });

  it("중복 적용·닫기를 막고 부분 실패를 보존한다", async () => {
    vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
    let finish!: (value: ReplacementReport) => void;
    const apply = vi.spyOn(api, "applyReplacement").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { store, close } = await mount();
    const changed = vi.spyOn(store, "externalChange").mockImplementation(() => {});
    await act(async () => { button(t.wsApply).click(); button(t.wsApply).click(); });
    host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    await act(async () => finish({ applied: [{ path: "/old/ref.md", count: 1 }], failed: [{ path: "/old/other.md", message: "changed on disk" }] }));
    expect(changed).toHaveBeenCalledWith("/old/ref.md", "changed");
    expect(host.textContent).toContain("changed on disk");
    expect(host.textContent).toContain(t.wsPartial);
    await act(async () => button(t.close).click());
    expect(close).toHaveBeenCalledWith(false);
  });

  it("미리보기 실패와 빈 결과를 구별하고 다시 준비할 수 있다", async () => {
    const prepare = vi.spyOn(api, "previewWikiRename").mockRejectedValueOnce(new Error("unreadable folder"))
      .mockResolvedValue({ id: 8, files: [], skipped: [] });
    const { close } = await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("unreadable folder");
    expect(host.textContent).not.toContain(t.wsNoChanges);
    await act(async () => button(t.wsPreview).click());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(t.wsNoChanges);
    await act(async () => button(t.close).click());
    expect(close).toHaveBeenCalledWith(true);
  });
});


it("그래프는 늦게 받은 연결을 반영하고 조회 실패를 연결 없음과 구별한다", async () => {
  vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
  const { store } = await mount();
  store.state.tree = ["a", "b"].map((name) => ({ kind: "file" as const, name: `${name}.md`, stem: name, path: `/old/${name}.md` }));
  const retry = vi.fn();
  const render = async (links: Array<{ from: string; to: string }>, error: string | null = null) => {
    await act(async () => root!.render(<GraphView store={store} t={t} links={links} error={error}
      onRetry={retry} onClose={() => {}} onOpen={() => {}} />));
  };
  await render([]);
  expect(host.querySelectorAll(".graph-edge")).toHaveLength(0);
  const links = [{ from: "/old/a.md", to: "/old/b.md" }];
  await render(links);
  expect(host.querySelectorAll(".graph-edge")).toHaveLength(1);
  await render(links, "unreadable");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("unreadable");
  expect(host.querySelector(".graph-svg")).toBeNull();
  await act(async () => button(t.wsRetry).click());
  expect(retry).toHaveBeenCalledTimes(1);
});


it("완료 기록 저장 실패 시 검토를 유지하고 완료 기록만 재시도한다", async () => {
  vi.spyOn(api, "previewWikiRename").mockResolvedValue({ id: 9, files: [], skipped: [] });
  const { close } = await mount();
  const finish = vi.mocked(api.finishRenameReview).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  await act(async () => button(t.close).click());
  expect(close).not.toHaveBeenCalled();
  expect(host.textContent).toContain(t.renameJobsFinishFailed);
  await act(async () => button(t.close).click());
  expect(finish).toHaveBeenCalledTimes(2);
  expect(finish).toHaveBeenLastCalledWith(target.id);
  expect(close).toHaveBeenCalledWith(true);
});

async function mountSidebar(jobs: bridge.PendingRename[] = [target]) {
  vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  let notify!: () => void;
  vi.spyOn(bridge, "onPendingRenamesChanged").mockImplementation(async (handler) => { notify = handler; return () => {}; });
  const pending = vi.spyOn(api, "pendingRenames").mockResolvedValue(jobs);
  const io: StoreIO = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  store.state.workspace = "/old";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Sidebar store={store} tree={[]} workspace="/old" activePath={null}
    open t={t} onModalChange={() => {}} />));
  return { pending, notify };
}

it("새 창에서도 저장된 작업을 불러와 ID로 검토를 재개한다", async () => {
  const prepare = vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
  await mountSidebar();
  expect(host.textContent).toContain(target.from);
  expect(host.textContent).toContain(t.renameLinksPending);
  await act(async () => button(t.renameLinksReview).click());
  expect(prepare).toHaveBeenCalledWith(target.id);
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});

it("재조회·작업 삭제 실패에도 기존 보류 기록을 보존한다", async () => {
  const finish = vi.spyOn(api, "finishRenameReview").mockRejectedValue(new Error("cannot acknowledge"));
  const { pending, notify } = await mountSidebar();
  pending.mockRejectedValue(new Error("read failed"));
  await act(async () => notify());
  expect(host.textContent).toContain("read failed");
  expect(host.textContent).toContain(target.to);
  await act(async () => button(t.renameLinksSkip).click());
  expect(finish).toHaveBeenCalledWith(target.id, true);
  expect(host.textContent).toContain("cannot acknowledge");
  expect(host.textContent).toContain(target.to);
});

it("중단된 작업은 자동 재실행하지 않고 확인 가능한 상태로 남긴다", async () => {
  const prepare = vi.spyOn(api, "previewWikiRename").mockResolvedValue(preview);
  const job = { ...target, ready: false, error: "original path still exists" };
  await mountSidebar([job]);
  expect(button(t.renameLinksReview).disabled).toBe(true);
  expect(host.textContent).toContain("original path still exists");
  expect(prepare).not.toHaveBeenCalled();
});

it("늦은 목록 응답은 완료 처리한 보류 작업을 되살리지 않는다", async () => {
  vi.spyOn(api, "finishRenameReview").mockResolvedValue(undefined);
  const { pending, notify } = await mountSidebar();
  let reply!: (jobs: bridge.PendingRename[]) => void;
  pending.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; })).mockResolvedValue([]);
  await act(async () => notify());
  await act(async () => button(t.renameLinksSkip).click());
  await act(async () => reply([target]));
  expect(host.textContent).not.toContain(target.to);
});


it("완료 기록을 저장할 수 없어도 보류 작업을 남기고 닫을 수 있다", async () => {
  vi.spyOn(api, "previewWikiRename").mockResolvedValue({ id: 9, files: [], skipped: [] });
  const { close } = await mount();
  const finish = vi.mocked(api.finishRenameReview).mockRejectedValue(new Error("offline"));
  await act(async () => button(t.close).click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => button(t.renameJobsKeepPending).click());
  expect(finish).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(false);
});
