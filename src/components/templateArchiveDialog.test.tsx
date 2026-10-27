// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type TemplateArchive, type UserTemplateList } from "../api";
import { makeT } from "../i18n";
import { TemplateArchiveDialog } from "./TemplateArchiveDialog";

const picks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), pickTemplateArchive: picks.open, pickSave: picks.save }));
const t = makeT("en");
const snapshot: UserTemplateList = { revision: 7, templates: [
  { id: "one", name: "First", description: "First description", version: 6 },
  { id: "two", name: "Second", description: "Second description", version: 7 },
] };
const archive: TemplateArchive = { format: "iyagi-markdown-templates", version: 1, templates: [
  { name: "First", description: "First description", content: "# One\r\n{{date}}\r\n" },
  { name: "Second", description: "Second description", content: "<script>raw text</script>" },
] };
let host: HTMLDivElement, root: Root, close: ReturnType<typeof vi.fn>, imported: ReturnType<typeof vi.fn>;
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!; }
function apply() { return host.querySelector<HTMLButtonElement>(".btn-primary")!; }
async function render(mode: "import" | "export") {
  await act(async () => root.render(<TemplateArchiveDialog mode={mode} snapshot={snapshot} t={t} onClose={close} onImported={imported} />));
}
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  close = vi.fn(); imported = vi.fn().mockResolvedValue(undefined);
  picks.open.mockReset().mockResolvedValue("/backups/templates.json"); picks.save.mockReset().mockResolvedValue("/backups/export.json");
  vi.spyOn(api, "readTemplateArchive").mockResolvedValue(archive);
  vi.spyOn(api, "importTemplateArchive").mockResolvedValue(9);
  vi.spyOn(api, "exportTemplateArchive").mockResolvedValue(undefined);
  vi.spyOn(api, "listUserTemplates").mockResolvedValue(snapshot);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("파일 검토만으로 저장하지 않으며 선택한 원문만 새 식별자로 가져온다", async () => {
  await render("import"); expect(apply().disabled).toBe(true);
  await act(async () => button(t.templateArchiveChoose).click());
  expect(host.textContent).toContain("/backups/templates.json");
  expect(api.importTemplateArchive).not.toHaveBeenCalled();
  await act(async () => button(`${t.templateSource}: Second`).click());
  expect(host.querySelector("pre")?.textContent).toBe("<script>raw text</script>");
  expect(host.querySelector("script")).toBeNull();
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
  await act(async () => apply().click());
  const [entries] = vi.mocked(api.importTemplateArchive).mock.calls[0];
  expect(entries).toHaveLength(1); expect(entries[0].content).toBe(archive.templates[0].content);
  expect(entries[0].expectedVersion).toBeNull(); expect(entries[0].id).not.toBe("one");
  expect(imported).toHaveBeenCalledTimes(1);
});

it("응답 유실 뒤 다시 시도해도 같은 식별자와 선택 내용을 사용한다", async () => {
  await render("import"); await act(async () => button(t.templateArchiveChoose).click());
  vi.mocked(api.importTemplateArchive).mockRejectedValueOnce(new Error("lost response"));
  await act(async () => apply().click());
  const first = vi.mocked(api.importTemplateArchive).mock.calls[0][0];
  expect(host.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
  await act(async () => apply().click());
  expect(vi.mocked(api.importTemplateArchive).mock.calls[1][0]).toEqual(first);
  expect(imported).toHaveBeenCalledTimes(1);
});

it("가져오기 중 중복 클릭과 닫기를 막고 완료된 요청을 다시 실행하지 않는다", async () => {
  let finish!: (revision: number) => void;
  vi.mocked(api.importTemplateArchive).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("import"); await act(async () => button(t.templateArchiveChoose).click());
  const target = apply(); await act(async () => { target.click(); target.click(); });
  await act(async () => { host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(api.importTemplateArchive).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  await act(async () => finish(9)); await act(async () => apply().click());
  expect(api.importTemplateArchive).toHaveBeenCalledTimes(1);
});

it("잘못된 파일은 이전 검토 내용을 비우고 저장을 막으며 파일 선택 취소는 저장하지 않는다", async () => {
  await render("import"); await act(async () => button(t.templateArchiveChoose).click());
  vi.mocked(api.readTemplateArchive).mockRejectedValueOnce({ code: "archiveInvalid" });
  await act(async () => button(t.templateArchiveChoose).click());
  expect(host.textContent).toContain(t.templateArchiveInvalid); expect(apply().disabled).toBe(true);
  picks.open.mockResolvedValueOnce(null); await act(async () => button(t.templateArchiveChoose).click());
  expect(api.readTemplateArchive).toHaveBeenCalledTimes(2); expect(api.importTemplateArchive).not.toHaveBeenCalled();
});

it("저장 대화상자 취소는 파일을 쓰지 않고 실제 내보내기는 확인한 항목·버전을 보낸다", async () => {
  await render("export"); picks.save.mockResolvedValueOnce(null);
  await act(async () => apply().click()); expect(api.exportTemplateArchive).not.toHaveBeenCalled();
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
  await act(async () => apply().click());
  expect(api.exportTemplateArchive).toHaveBeenCalledWith("/backups/export.json", ["one"], 7);
  expect(host.textContent).toContain("/backups/export.json");
});

it("다른 창의 변경은 최신 목록을 다시 검토하게 하고 자동으로 내보내지 않는다", async () => {
  await render("export"); vi.mocked(api.exportTemplateArchive).mockRejectedValueOnce({ code: "changed" });
  vi.mocked(api.listUserTemplates).mockResolvedValue({ revision: 8, templates: [{ ...snapshot.templates[0], name: "Latest", version: 8 }] });
  await act(async () => apply().click());
  expect(host.textContent).toContain(t.templateArchiveChanged); expect(host.textContent).toContain("Latest");
  expect(api.exportTemplateArchive).toHaveBeenCalledTimes(1);
  await act(async () => apply().click());
  expect(api.exportTemplateArchive).toHaveBeenLastCalledWith("/backups/export.json", ["one"], 8);
});

it("닫은 뒤에 도착한 읽기 응답은 가져오기를 시작하지 않는다", async () => {
  let finish!: (value: TemplateArchive) => void;
  vi.mocked(api.readTemplateArchive).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("import"); await act(async () => button(t.templateArchiveChoose).click());
  await act(async () => root.render(null)); await act(async () => finish(archive));
  expect(api.importTemplateArchive).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled();
});
