// 최상위 오류 경계 — 어느 컴포넌트의 렌더 크래시도 앱 전체 백화로 가지
// 않게 한다. 문서 내용은 자동 저장·세션에 있으니 안내 화면에서 새로고침으로
// 복구(편집 중 크래시여도 직전 입력의 1.5초를 제외하고 무사).
// 경계 아래 트리가 실패한 상태라 t/i18n를 못 쓴다 — 이중 언어 하드코딭.

import React from "react";

import { api, isInApp } from "../api";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // 진단은 콘솔 + 앱 로그 파일(로그 폴더 열기로 사용자가 보낼 수 있다).
    console.error("UI 크래시:", error, info);
    if (isInApp()) void api.logError(`UI crash: ${error.message}\n${String(info)}`).catch(() => {});
  }

  render(): React.ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="overlay modal-overlay" role="alertdialog" aria-modal="true">
          <div className="modal">
            <div className="modal-title">화면을 그리지 못했습니다</div>
            <p className="modal-text" style={{ userSelect: "text", whiteSpace: "pre-wrap" }}>
              {String(this.state.error.message ?? this.state.error)}
              {"\n\n"}
              The screen failed to render — your document is auto-saved.
              {"\n"}
              문서는 자동 저장돼 있습니다.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => window.location.reload()}>
                다시 열기 · Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
