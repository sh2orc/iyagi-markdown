// 모달 — 미저장 확인(창/탭 닫기)과 외부 변경 충돌 안내.

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
  const dirtyTabs = store.state.tabs.filter((x) => x.state.doc.toString() !== x.savedText);
  const name = dirtyTabs[0]?.path?.split("/").pop() ?? t.untitled;
  return (
    <div className="overlay modal-overlay">
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
              // 저장 후 진행.
              for (const tab of dirtyTabs) {
                if (tab.path) await store.saveActive();
              }
              onDone(true);
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
  const removed = tab.conflict === "removed";
  const name = tab.path?.split("/").pop() ?? t.untitled;
  return (
    <div className="overlay modal-overlay">
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
