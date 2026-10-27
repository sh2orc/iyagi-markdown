// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { captureExportSnapshot } from "./snapshot";
import { createPreviewRenderer, paperDimensions, snapshotHtmlOptions, type PdfOptions } from "./preview";
const mocks = vi.hoisted(() => ({ body: vi.fn(), html: vi.fn() }));
vi.mock("./html", () => ({ renderExportBody: mocks.body, buildExportHtml: mocks.html }));
const options: PdfOptions = { paper: "a5", orientation: "landscape", marginMm: 12, scale: 1.25 };
const snapshot = (theme: "light" | "dark" = "light") => captureExportSnapshot({
  state: EditorState.create({ doc: "---\ntitle: Report\ncolumns: 2\ntoc: true\nheader: Custom header\nfooter: Footer\n---\n# Body\n[[Other]]" }),
  path: "/w/a.md", title: "a.md", docStyle: null, comments: [], savedText: "",
}, { workspace: "/w", theme, pageNumbers: true, header: false,
  wikiIndex: new Map([["other", ["/w/Other.md"]]]), lang: "en" });
beforeEach(() => {
  mocks.body.mockReset().mockResolvedValue("<h1>Body</h1>");
  mocks.html.mockReset().mockImplementation(async (_text, opts) => opts.preRendered);
});

it("PDF와 미리보기 옵션에 쪽번호·다단 원문·목차·머리글·언어가 함께 전달된다", () => {
  const source = snapshot();
  const actual = snapshotHtmlOptions(source, undefined, options);
  expect(source.markdown).toContain("columns: 2");
  expect(source.text).not.toContain("columns: 2");
  expect(actual).toMatchObject({ forPdf: true, theme: "light", paper: "a5", orientation: "landscape",
    marginMm: 12, scale: 1.25, lang: "en", pageNumbers: true, pdfHeader: "Custom header", pdfFooter: "Footer",
    frontLists: { toc: true, lof: false, lot: false } });
  expect(paperDimensions(options)).toEqual([210, 148]);
  expect(paperDimensions({ paper: "letter", orientation: "portrait" })).toEqual([215.9, 279.4]);
});

it("옵션 변경 중 진행 중인 본문 렌더도 재사용하고 최신 옵션으로 조립한다", async () => {
  // 동적 import 해석을 미리 플러시한다 — 나란히 시작한 두 import("./html")가
  // 목·실제 모듈로 갈라지는 비결정성을 없앤다.
  await import("./html");
  const source = snapshot(), render = createPreviewRenderer();
  let finish!: (body: string) => void;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  mocks.body.mockImplementationOnce(() => {
    bodyStarted(); // 첫 렌더가 본문을 시작했다 — 모듈 해석도 끝났다.
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = render(source, snapshotHtmlOptions(source, undefined, options));
  await started;
  const second = render(source, snapshotHtmlOptions(source, undefined, { ...options, scale: 2 }));
  expect(typeof finish).toBe("function");
  finish("<h1>Captured</h1>"); await Promise.all([first, second]);
  // 진행 중 본문 재사용 — body는 첫 렌더만 부른다.
  expect(mocks.body).toHaveBeenCalledTimes(1);
  expect(mocks.html.mock.calls.map(([, opts]) => opts.scale)).toEqual([1.25, 2]);
  expect(mocks.html.mock.calls.every(([text]) => text.includes("columns: 2"))).toBe(true);
});

it("실패한 본문은 캐시하지 않고 테마·새 창의 미리보기는 별도로 렌더한다", async () => {
  const source = snapshot(), render = createPreviewRenderer();
  mocks.body.mockRejectedValueOnce(new Error("render failed"));
  await expect(render(source, snapshotHtmlOptions(source, undefined, options))).rejects.toThrow("render failed");
  await render(source, snapshotHtmlOptions(source, undefined, options));
  const dark = snapshot("dark");
  await render(dark, snapshotHtmlOptions(dark, undefined));
  await createPreviewRenderer()(source, snapshotHtmlOptions(source, undefined, options));
  expect(mocks.body).toHaveBeenCalledTimes(4);
  expect(mocks.body.mock.calls[2][1].theme).toBe("dark");
});
