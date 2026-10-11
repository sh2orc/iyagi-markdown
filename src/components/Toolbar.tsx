// 서식 도구모음(Word "홈" 리본의 컴팩트 판) — 모든 동작은 원문 텍스트 편집이다(§4-1).

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";

interface Props {
  store: AppStore;
  t: Translate;
}

function ToolBtn({
  label,
  title,
  onClick,
  disabled,
  narrow,
}: {
  label: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  narrow?: boolean;
}) {
  return (
    <button
      className={`tb-btn ${narrow ? "tb-btn-narrow" : ""}`}
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

export function Toolbar({ store, t }: Props): JSX.Element {
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
        <ToolBtn label={<b>B</b>} title={`${t.tbBold} (⌘B)`} disabled={disabled} onClick={() => run(fmt.toggleBold)} />
        <ToolBtn label={<i>I</i>} title={`${t.tbItalic} (⌘I)`} disabled={disabled} onClick={() => run(fmt.toggleItalic)} />
        <ToolBtn label={<s>S</s>} title={`${t.tbStrike} (⌘⇧X)`} disabled={disabled} onClick={() => run(fmt.toggleStrikethrough)} />
        <ToolBtn label={<span className="tb-mono">{"</>"}</span>} title={t.tbCode} disabled={disabled} onClick={() => run(fmt.toggleInlineCode)} />
        <ToolBtn label={<span className="tb-link-ico">🔗</span>} title={t.tbLink} disabled={disabled} onClick={() => run((v) => fmt.insertLink(v))} />
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
        <ToolBtn narrow label="▦" title={t.tbTable} disabled={disabled} onClick={() => run((v) => fmt.insertTable(v))} />
        <ToolBtn narrow label="―" title={t.tbRule} disabled={disabled} onClick={() => run((v) => fmt.insertBlock(v, "---"))} />
      </div>
    </div>
  );
}
