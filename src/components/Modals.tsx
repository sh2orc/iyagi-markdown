// 모달 — 미저장 확인(창/탭 닫기)과 외부 변경 충돌 안내.

import { useEffect, useRef } from "react";

import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";

export function CloseConfirm({
  store,
  t,
  onDone,
}: {
  store: AppStore;
  t: Translate;
  onDone: (proceed: boolean) => void;
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dirtyTabs = store.state.tabs.filter((x) => x.dirty);
  const name = dirtyTabs[0]?.path?.split("/").pop() ?? t.untitled;

  // 오버레이 자체 포커스 — Esc=취소(macOS 알림 관례: 취소 버튼과 동일).
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone(false);
        }
      }}
    >
      <div className="modal">
        <div className="modal-title">{t.dirtyTitle}</div>
        <p className="modal-text">
          {t.dirtyQuoteBefore}
          {name}
          {dirtyTabs.length > 1 ? ` (+${dirtyTabs.length - 1})` : ""}
          {t.dirtyQuoteAfter}
        </p>
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={async () => {
              // 저장 후 진행 — saveActive는 '활성' 탭만 저장하므로 각 탭으로
              // 전환해가며 저장하고, 끝나면 원래 활성 탭으로 되돌린다.
              // 저장에 실패한 탭이 하나라도 있으면 닫지 않는다(유실 방지 —
              // 저장 실패는 saveActive가 토스트로 안내한다).
              const restoreId = store.state.activeId;
              let failed = false;
              for (const tab of dirtyTabs) {
                if (!tab.path) continue;
                store.activate(tab.id);
                if (!(await store.saveActive())) failed = true;
              }
              if (restoreId && store.state.activeId !== restoreId) {
                const back = store.state.tabs.find((x) => x.id === restoreId);
                if (back) store.activate(restoreId);
              }
              onDone(failed ? false : true);
            }}
          >
            {t.dirtySave}
          </button>
          <button className="btn" onClick={() => onDone(true)}>
            {t.dirtyDiscard}
          </button>
          <button className="btn btn-plain" onClick={() => onDone(false)}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConflictDialog({
  store,
  tab,
  t,
}: {
  store: AppStore;
  tab: Tab;
  t: Translate;
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const removed = tab.conflict === "removed";
  const name = tab.path?.split("/").pop() ?? t.untitled;

  // 오버레이 자체 포커스 — Esc=내 것 유지(최소 파괴). 파일 삭제 충돌은
  // 선택이 모두 파괴적이라 Esc를 두지 않는다.
  useEffect(() => {
    if (!removed) overlayRef.current?.focus();
  }, [removed]);

  return (
    <div
      ref={overlayRef}
      tabIndex={removed ? undefined : -1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={
        removed
          ? undefined
          : (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                store.keepMine(tab.id);
              }
            }
      }
    >
      <div className="modal">
        <div className="modal-title">{t.extChangedTitle}</div>
        <p className="modal-text">
          {removed ? t.extRemoved : t.extChangedConflict}
          <br />
          <code className="modal-file">{name}</code>
        </p>
        <div className="modal-actions">
          {!removed && (
            <button
              className="btn btn-primary"
              onClick={() => void store.reloadTab(tab.id, true)}
            >
              {t.extReload}
            </button>
          )}
          <button className="btn" onClick={() => store.keepMine(tab.id)}>
            {removed ? t.close : t.extKeepMine}
          </button>
        </div>
        {!removed && <p className="modal-hint">{t.extKeepMineHint}</p>}
      </div>
    </div>
  );
}
