// 이미지 확대 뷰어 — 에디터의 이미지를 클릭하면 전체 화면으로.
// 줌(스크롤·버튼)·팬(드래그)·회전·원본 크기·ESC 닫기. 읽기 전용 뷰어(원문 불변).

import { useEffect, useRef, useState } from "react";

import { convertFileSrc, isInApp } from "../api";
import type { Translate } from "../i18n";

interface Props {
  src: string;
  alt: string;
  t: Translate;
  onClose: () => void;
}

export function ImageViewer({ src, alt, t, onClose }: Props): JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; base: { x: number; y: number } } | null>(null);
  const url = !/^https?:|^data:/i.test(src) && isInApp() ? convertFileSrc(src) : src;

  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(8, z * 1.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.1, z / 1.25));
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <div
      className="imgviewer"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onWheel={(e) => {
        // 트랙패드 핀치(ctrl+wheel)와 일반 휠 모두 줌으로 — 뷰어 안에서는 스크롤이 의미 없다.
        // 배율은 deltaY 크기에 비례(지수 곡선) — 연속 이벤트 장치에서 한 번에
        // 최대 배율로 튀지 않고 손가락 움직임에 붙는다.
        if (e.ctrlKey || e.deltaY !== 0) {
          e.preventDefault();
          setZoom((z) => Math.min(8, Math.max(0.1, z * Math.exp(-e.deltaY * 0.0015))));
        }
      }}
    >
      <div className="imgviewer-bar">
        <span className="imgviewer-name" title={src}>
          {alt || src.split("/").pop()}
        </span>
        <button className="mtb-btn" title="-" onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>
          −
        </button>
        <span className="imgviewer-zoom">{Math.round(zoom * 100)}%</span>
        <button className="mtb-btn" title="+" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>
          +
        </button>
        <button className="mtb-btn" title="100%" onClick={reset}>
          1:1
        </button>
        <button className="mtb-btn" title="↻" onClick={() => setRot((r) => (r + 90) % 360)}>
          ↻
        </button>
        <button className="mtb-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div
        className={`imgviewer-stage ${dragging ? "is-dragging" : ""} ${zoom > 1 ? "can-pan" : ""}`}
        onPointerDown={(e) => {
          // 줌인 상태 드래그 팬 — 확대해 잘린 부분을 볼 수 있게.
          if (zoom <= 1) return;
          e.preventDefault();
          drag.current = { x: e.clientX, y: e.clientY, base: pan };
          setDragging(true);
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setPan({ x: d.base.x + (e.clientX - d.x), y: d.base.y + (e.clientY - d.y) });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={reset}
      >
        <img
          src={url}
          alt={alt}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rot}deg)`,
            willChange: "transform",
          }}
          draggable={false}
        />
      </div>
      <span className="imgviewer-hint">{t.cancel} · ESC</span>
    </div>
  );
}
