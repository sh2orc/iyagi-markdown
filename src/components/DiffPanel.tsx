// 문서 비교 뷰 — 활성 문서 vs 선택한 파일(또는 디스크 저장본). 읽기 전용.
// Word "문서 비교"에 대응. 원문은 어느 쪽도 수정하지 않는다.

import { useEffect, useMemo, useState } from "react";

import { api, pickOpenFile } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { diffLines, diffSummary } from "../editor/diff";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

export function DiffPanel({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  const [other, setOther] = useState<{ name: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // 기본 비교 대상: 디스크에 저장된 버전(dirty일 때 유용). 아니면 같은 내용.
  useEffect(() => {
    if (!tab?.path) return;
    setLoading(true);
    void api
      .readDocument(tab.path)
      .then((doc) => setOther({ name: `${tab.title} (disk)`, text: doc.text }))
      .catch(() => setOther(null))
      .finally(() => setLoading(false));
  }, [tab?.path]);

  const ops = useMemo(() => {
    if (!tab || !other) return [];
    return diffLines(tab.state.doc.toString(), other.text);
  }, [tab, other]);

  const summary = useMemo(() => diffSummary(ops), [ops]);
  const pickOther = async () => {
    const path = await pickOpenFile();
    if (!path) return;
    setLoading(true);
    try {
      const doc = await api.readDocument(path);
      setOther({ name: path.split("/").pop() ?? path, text: doc.text });
    } finally {
      setLoading(false);
    }
  };

  if (!tab) return null;

  return (
    <div className="overlay modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="diff-frame">
        <div className="print-head">
          <span className="print-title">
            {t.diffTitle}: {tab.title} ↔ {other?.name ?? "—"}
          </span>
          <span className="diff-summary">
            <span className="diff-add-c">+{summary.added}</span>{" "}
            <span className="diff-del-c">−{summary.removed}</span>
          </span>
          <button className="btn" onClick={() => void pickOther()}>
            {t.diffPick}
          </button>
          <button className="btn btn-plain" onClick={onClose}>
            {t.close}
          </button>
        </div>
        <div className="diff-body">
          {loading && <div className="print-loading"><div className="spinner" /></div>}
          {!loading && ops.length === 0 && <div className="palette-empty">{t.diffSame}</div>}
          {!loading &&
            ops.map((op, i) => (
              <pre key={i} className={`diff-line diff-${op.kind}`}>
                <span className="diff-gutter">{op.kind === "add" ? "+" : op.kind === "del" ? "−" : " "}</span>
                <code>{op.text}</code>
              </pre>
            ))}
        </div>
      </div>
    </div>
  );
}
