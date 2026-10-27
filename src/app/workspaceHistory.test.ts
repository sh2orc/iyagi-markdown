import { expect, it, vi } from "vitest";
import { WorkspaceHistory } from "./workspaceHistory";
import type { RecentSnapshot, WorkspaceHistoryAction } from "../api";
const snapshot = (revision: number, paths: string[]): RecentSnapshot => ({ revision, entries: paths.map((path) => ({ path, name: path.split("/").pop()! })) });

it("새 이벤트 뒤의 이전 조회 결과와 오류를 무시한다", async () => {
  let finish!: (value: RecentSnapshot) => void;
  const history = new WorkspaceHistory({ getWorkspaceHistory: () => new Promise((resolve) => { finish = resolve; }) });
  const reading = history.load(); history.accept(snapshot(2, ["/new"])); finish(snapshot(1, ["/old"])); await reading;
  expect(history.getSnapshot().entries[0].path).toBe("/new"); expect(history.getSnapshot().loading).toBe(false);
  let fail!: (error: unknown) => void;
  const other = new WorkspaceHistory({ getWorkspaceHistory: () => new Promise((_resolve, reject) => { fail = reject; }) });
  const pending = other.load(); other.accept(snapshot(3, ["/current"])); fail(new Error("old failure")); await pending;
  expect(other.getSnapshot().error).toBeNull(); expect(other.getSnapshot().entries[0].path).toBe("/current");
});

it("삭제를 미리 반영하지 않고 저장 실패 시 목록을 유지한 채 다시 시도한다", async () => {
  let fail!: (error: unknown) => void;
  const write = vi.fn<(_action: WorkspaceHistoryAction) => Promise<RecentSnapshot>>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockResolvedValue(snapshot(2, []));
  const history = new WorkspaceHistory({ updateWorkspaceHistory: write }); history.accept(snapshot(1, ["/keep"]));
  const removing = history.remove("/keep"); await Promise.resolve();
  expect(history.getSnapshot().entries).toHaveLength(1); expect(history.getSnapshot().busy).toBe(true);
  fail(new Error("disk full")); expect(await removing).toBe(false);
  expect(history.getSnapshot().entries).toHaveLength(1); expect(history.getSnapshot().error).toContain("disk full");
  expect(await history.remove("/keep")).toBe(true); expect(history.getSnapshot().entries).toEqual([]);
});

it("기록 큐를 기다리는 동안 폴더가 바뀌면 이전 열기를 기록하지 않는다", async () => {
  let finish!: (value: RecentSnapshot) => void;
  const write = vi.fn<(_action: WorkspaceHistoryAction) => Promise<RecentSnapshot>>()
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue(snapshot(2, ["/latest"]));
  const history = new WorkspaceHistory({ updateWorkspaceHistory: write });
  const first = history.record("/first", () => true); await Promise.resolve();
  let current = true; const stale = history.record("/stale", () => current); current = false;
  const latest = history.record("/latest", () => true);
  finish(snapshot(1, ["/first"])); await first; expect(await stale).toBe(false); await latest;
  expect(write.mock.calls.map(([action]) => action)).toEqual([{ kind: "record", path: "/first" }, { kind: "record", path: "/latest" }]);
  expect(history.getSnapshot().busy).toBe(false);
});
