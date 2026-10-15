// 서식 도구모음(Word "홈" 리본의 컴팩트 판) — 모든 동작은 원문 텍스트 편집이다(§4-1).

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";
import { redo, undo } from "@codemirror/commands";
import { api, pickImageFile } from "../api";
import { relPath } from "../paths";

interface Props {
  store: AppStore;
  t: Translate;
  /** ▦ 클릭 — 크기 지정 대화상자(⌥클릭은 즉시 3×3). */
  onInsertTable?: () => void;
}

function ToolBtn({
  label,
  title,
  onClick,
  disabled,
  narrow,
  active,
}: {
  label: React.ReactNode;
  title: string;
  onClick: (ev: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  narrow?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`tb-btn ${narrow ? "tb-btn-narrow" : ""} ${active ? "is-active" : ""}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // 에디터 포커스 유지
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const Sep = () => <span className="tb-sep" />;

export function Toolbar({ store, t, onInsertTable,
}: Props): JSX.Element {
  const state = store.getSnapshot();
  const view = store.view;
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  const disabled = !view || !tab || tab.mode === "read";

  const run = (fn: (v: NonNullable<typeof view>) => boolean) => {
    if (view) {
      fn(view);
      view.focus();
    }
  };

  return (
    <div className="toolbar" role="toolbar">
      <div className="tb-group">
        <ToolBtn narrow label="↩︎" title={`${t.ctxUndo} (⌘Z)`} disabled={disabled} onClick={() => run((v) => undo(v))} />
        <ToolBtn narrow label="↪︎" title={`${t.ctxRedo} (⇧⌘Z)`} disabled={disabled} onClick={() => run((v) => redo(v))} />
      </div>
      <Sep />
      <div className="tb-group">
        <ToolBtn label={<b>B</b>} title={`${t.tbBold} (⌘B)`} disabled={disabled} active={!!tab?.marks.bold} onClick={() => run(fmt.toggleBold)} />
        <ToolBtn label={<i>I</i>} title={`${t.tbItalic} (⌘I)`} disabled={disabled} active={!!tab?.marks.italic} onClick={() => run(fmt.toggleItalic)} />
        <ToolBtn label={<s>S</s>} title={`${t.tbStrike} (⌘⇧X)`} disabled={disabled} active={!!tab?.marks.strike} onClick={() => run(fmt.toggleStrikethrough)} />
        <ToolBtn label={<span className="tb-mono">{"</>"}</span>} title={t.tbCode} disabled={disabled} active={!!tab?.marks.code} onClick={() => run(fmt.toggleInlineCode)} />
        <ToolBtn label={<span className="tb-link-ico">🔗</span>} title={t.tbLink} disabled={disabled} active={!!tab?.marks.link} onClick={() => run((v) => fmt.insertLink(v))} />
        <ToolBtn
          narrow
          label={<span className="tb-math-ico">∑</span>}
          title={`${t.tbMath} (⌥: ${t.tbMathBlock})`}
          disabled={disabled}
          onClick={(ev) => run((v) => fmt.insertMath(v, ev.altKey))}
        />
      </div>
      <Sep />
      <div className="tb-group">
        <ToolBtn narrow label="H1" title={`${t.tbHeading} 1`} disabled={disabled} onClick={() => run((v) => fmt.toggleHeading(v, 1))} />
        <ToolBtn narrow label="H2" title={`${t.tbHeading} 2`} disabled={disabled} onClick={() => run((v) => fmt.toggleHeading(v, 2))} />
        <ToolBtn narrow label="H3" title={`${t.tbHeading} 3`} disabled={disabled} onClick={() => run((v) => fmt.toggleHeading(v, 3))} />
      </div>
      <Sep />
      <div className="tb-group">
        <ToolBtn narrow label="•—" title={t.tbBullet} disabled={disabled} onClick={() => run(fmt.toggleBulletList)} />
        <ToolBtn narrow label="1." title={t.tbNumbered} disabled={disabled} onClick={() => run(fmt.toggleOrderedList)} />
        <ToolBtn narrow label="❝" title={t.tbQuote} disabled={disabled} onClick={() => run(fmt.toggleQuote)} />
      </div>
      <Sep />
      <div className="tb-group">
        <ToolBtn
          narrow
          label="🖼"
          title={t.tbImage}
          disabled={disabled}
          onClick={() => {
            void (async () => {
              const picked = await pickImageFile();
              if (!picked) return;
              const tab = store.active;
              const dir = tab?.path
                ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
                : store.state.workspace;
              if (!tab || !dir || !store.view) return;
              try {
                const absPath = await api.importImage(picked, dir);
                fmt.insertImageRef(store.view, relPath(dir, absPath));
                store.view.focus();
              } catch {
                /* 취소·실패 무시 */
              }
            })();
          }}
        />
        <ToolBtn
          narrow
          label="▦"
          title={`${t.tbTable} (⌥: 3×3)`}
          disabled={disabled}
          onClick={(ev) => {
            if (ev.altKey) run((v) => fmt.insertTable(v));
            else onInsertTable?.();
          }}
        />
        <ToolBtn narrow label="―" title={t.tbRule} disabled={disabled} onClick={() => run((v) => fmt.insertBlock(v, "---"))} />
      </div>
    </div>
  );
}
