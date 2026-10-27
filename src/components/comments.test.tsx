// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommentDialog } from "./CommentDialog";
import { CommentsPanel } from "./CommentsPanel";
import { ContextMenu } from "./ContextMenu";
import { EditorView } from "@codemirror/view";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";

const t = makeT("en");
let root: Root | undefined;
let host: HTMLDivElement;
let editor: EditorView | undefined;
let editorHost: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  editor?.destroy();
  editor = undefined;
  editorHost?.remove();
  editorHost = undefined;
  vi.restoreAllMocks();
});
async function render(element: JSX.Element) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}
function type(text: string) {
  const textarea = host.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("메모 입력 보존", () => {
  it("실패하면 입력을 그대로 두고 재시도할 수 있다", async () => {
    const confirm = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const cancel = vi.fn();
    await render(<CommentDialog t={t} lineNo={2} onConfirm={confirm} onCancel={cancel} />);
    act(() => type("my comment"));
    await act(async () => button(t.save).click());
    expect(host.querySelector("textarea")!.value).toBe("my comment");
    expect(host.textContent).toContain("disk full");
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => button(t.save).click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith("my comment");
  });

  it("진행 중 단축키 중복 제출과 Esc·배경 클릭 닫기를 차단한다", async () => {
    let finish!: () => void;
    const confirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancel = vi.fn();
    await render(<CommentDialog t={t} lineNo={1} initial="draft" onConfirm={confirm} onCancel={cancel} />);
    act(() => {
      const textarea = host.querySelector("textarea")!;
      for (let i = 0; i < 2; i++) textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      host.querySelector<HTMLElement>(".overlay")!.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await act(async () => finish());
  });

  it("미저장 입력을 버리기 전에 확인하고 계속 편집할 수 있다", async () => {
    const cancel = vi.fn();
    await render(<CommentDialog t={t} lineNo={1} onConfirm={async () => {}} onCancel={cancel} />);
    act(() => type("keep this"));
    act(() => button(t.cancel).click());
    expect(cancel).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.commentDiscardPrompt);
    act(() => button(t.commentKeepEditing).click());
    expect(host.querySelector("textarea")!.value).toBe("keep this");
    act(() => button(t.cancel).click());
    act(() => button(t.commentDiscard).click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

async function panel() {
  const comment = { id: 3, lineNo: 1, text: "original", createdAt: 1, resolved: false };
  const io: StoreIO = {
    readDocument: async () => ({ text: "# doc", meta: { hadBom: false, crlf: false }, mtime: 1, size: 5 }),
    writeDocument: async () => ({ mtime: 2, size: 5 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }), saveSession: async () => {},
    setAssetScope: async () => {}, watchPaths: async () => {}, commentList: async () => [comment],
  };
  const store = new AppStore(io);
  store.newTabWithContent("# doc");
  store.active!.path = "/a.md";
  store.active!.title = "a.md";
  const target = { id: store.active!.id, path: "/a.md" };
  await render(<CommentsPanel store={store} t={t} onClose={vi.fn()} />);
  return { store, io, target, comment };
}

describe("메모 패널의 대상과 확인", () => {
  it("다른 탭을 열어도 원래 문서와 수정 시작 시 내용을 사용한다", async () => {
    const { store, target, comment } = await panel();
    const edit = vi.spyOn(store, "editComment").mockResolvedValue(undefined);
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${t.commentEdit}"]`)!.click());
    act(() => {
      store.newTabWithContent("# other");
      store.active!.path = "/b.md";
    });
    act(() => type("my edit"));
    await act(async () => button(t.save).click());
    expect(edit).toHaveBeenCalledWith(expect.objectContaining(target), comment, "my edit");
  });

  it("삭제 버튼은 즉시 삭제하지 않고 확인한 메모만 보낸다", async () => {
    const { store, target, comment } = await panel();
    const remove = vi.spyOn(store, "removeComment").mockResolvedValue(undefined);
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${t.commentDelete}"]`)!.click());
    expect(remove).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.commentDeletePrompt);
    await act(async () => button(t.commentDelete).click());
    expect(remove).toHaveBeenCalledWith(expect.objectContaining(target), comment);
  });

  it("조회 실패는 빈 메모 표시로 바뀌지 않고 재조회할 수 있다", async () => {
    const { store, io } = await panel();
    io.commentList = async () => { throw new Error("db unavailable"); };
    await act(async () => store.refreshComments("/a.md"));
    expect(host.textContent).toContain(t.commentsLoadFailed);
    expect(host.textContent).toContain("original");
    expect(host.textContent).not.toContain(t.commentsEmpty);
    io.commentList = async () => [];
    await act(async () => button(t.wsRetry).click());
    expect(host.textContent).toContain(t.commentsEmpty);
  });
});


describe("우클릭 메뉴의 메모 대화상자", () => {
  it("메뉴가 닫힌 뒤에도 입력창이 유지되고 저장 실패를 표시한다", async () => {
    const io: StoreIO = {
      readDocument: async () => ({ text: "# doc", meta: { hadBom: false, crlf: false }, mtime: 1, size: 5 }),
      writeDocument: async () => ({ mtime: 2, size: 5 }),
      scanWorkspace: async () => ({ tree: [], issues: [] }), saveSession: async () => {},
      setAssetScope: async () => {}, watchPaths: async () => {},
    };
    const store = new AppStore(io);
    store.newTabWithContent("# doc");
    store.active!.path = "/context.md";
    editorHost = document.createElement("div");
    editorHost.className = "editor-host";
    document.body.append(editorHost);
    editor = new EditorView({ parent: editorHost, state: store.active!.state });
    store.view = editor;
    vi.spyOn(editor, "posAtCoords").mockReturnValue(0);
    const add = vi.spyOn(store, "addComment").mockRejectedValue(new Error("write failed"));
    const modalChange = vi.fn();
    await render(<ContextMenu store={store} t={t} onModalChange={modalChange} />);
    act(() => editorHost!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
    act(() => button(t.ctxAddComment).click());
    expect(host.querySelector(".ctx-menu")).toBeNull();
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(modalChange).toHaveBeenLastCalledWith(true);
    act(() => type("do not lose this"));
    await act(async () => button(t.save).click());
    expect(add).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("write failed");
    expect(host.querySelector("textarea")!.value).toBe("do not lose this");
  });
});
