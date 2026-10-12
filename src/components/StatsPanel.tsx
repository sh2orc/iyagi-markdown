// 문서 통계 패널 — Word의 "검토 > 문서 통계". 상태 줄의 통계를 클릭하면 연다.
// 스토어의 증분 카운터 + 문단·제목·표·읽기 시간은 여는 순간에만 계산한다.

import type { AppStore } from "../app/store";
import { sentenceSpans } from "../editor/writing";
import { stripFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";
import { collectHeadings } from "../links";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

function readingMinutes(text: string): number {
  // 한국어 ≈ 500자/분, 라틴 단어 ≈ 220단어/분 — 섞인 문서는 둘을 합산해 환산.
  const cjk = (text.match(/[가-힣぀-ヿ一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9'’_-]+/g) ?? []).length;
  return Math.max(1, Math.round(cjk / 500 + latin / 220));
}

export function StatsPanel({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  if (!tab) return null;
  const text = tab.state.doc.toString();
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim()).length;
  const headings = collectHeadings(text).length;
  const tables = (text.match(/^\|[\s:|-]+\|\s*$/gm) ?? []).length;
  const codeBlocks = (text.match(/^```/gm) ?? []).length / 2;
  // 문장 지표(작가용) — sentenceSpans 재활용(14차). 본문만(FM 제외).
  const body = stripFrontMatter(text);
  const spans = sentenceSpans(body);
  const sentences = spans.length;
  const avgSentenceLen = sentences > 0 ? body.replace(/\s+/g, " ").length / sentences : 0;

  const rows: Array<[string, string]> = [
    [t.f.words(tab.words), String(tab.words)],
    [t.f.chars(tab.chars), String(tab.chars)],
    [t.statParagraphs, String(paragraphs)],
    [t.tocTitle, String(headings)],
    [t.tbTable, String(Math.floor(tables))],
    ["Code", String(Math.floor(codeBlocks))],
    [t.statReading, `${readingMinutes(text)} ${t.statMin}`],
    [t.statSentences, String(sentences)],
    [t.statAvgSentence, `${avgSentenceLen.toFixed(1)} ${t.statChars}`],
  ];
  void t;

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="modal-title">
          {t.statsTitle}
          <span className="modal-file-name">{tab.path ? tab.title : t.untitled}</span>
        </div>
        <table className="stats-table">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="stats-label">{label}</td>
                <td className="stats-value">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
