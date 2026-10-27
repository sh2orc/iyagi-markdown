// 문서 통계 패널 — Word의 "검토 > 문서 통계". 상태 줄의 통계를 클릭하면 연다.
// 스토어의 증분 카운터 + 문단·제목·표·읽기 시간은 여는 순간에만 계산한다.

import type { AppStore } from "../app/store";
import { sentenceLengthStats, sentenceSpans } from "../editor/writing";
import { smoothScrollIntoView } from "../editor/cm";
import { stripFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";
import { collectHeadings } from "../links";
import { duplicateHeadings } from "../app/tocTree";

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
  // ``` 와 ~~~ 펜스를 모두 센다(앱 전반의 펜스 규약) — 짝이 없는 열린
  // 펜스는 floor로 반올림된다.
  const codeBlocks = (text.match(/^(?:```|~~~)/gm) ?? []).length / 2;
  // 문장 지표(작가용) — sentenceSpans 재활용(14차). 본문만(FM 제외).
  const body = stripFrontMatter(text);
  const spans = sentenceSpans(body);
  const sentences = spans.length;
  const avgSentenceLen = sentences > 0 ? body.replace(/\s+/g, " ").length / sentences : 0;
  // 문장 길이 분포(가독성 진단 — Word 읽기 쉬운 정도 지표의 대응물).
  const sls = sentenceLengthStats(body, store.state.settings.longSentenceMin);
  // 긴 문장 목록 — 클릭하면 그 자리로(글쓰기 검토). 기준은 분포 차트와
  // 같은 사용자 설정(longSentenceMin) — 같은 패널안 두 기준이 어긋나면
  // "보통"으로 분류된 문장이 긴 문장 목록에 등장한다.
  const longMin = store.state.settings.longSentenceMin;
  const longSentences = spans
    .map(([a, b]) => ({ pos: a, text: body.slice(a, b).replace(/\s+/g, " ").trim() }))
    .filter((x) => x.text.replace(/\s+/g, "").length >= longMin)
    .slice(0, 30);
  const bucketMax = Math.max(1, ...sls.buckets);
  const bucketRows: Array<[string, number, string]> = [
    [t.statShort, sls.buckets[0], "b-short"],
    [t.statNormal, sls.buckets[1], "b-normal"],
    [t.statLong, sls.buckets[2], "b-long"],
    [t.statVeryLong, sls.buckets[3], "b-vlong"],
  ];

  // 집필 목표 진행(139차) — 상태 줄 %의 시각판.
  const goal = store.state.settings.writingGoal;
  const goalPct = goal > 0 ? Math.min(100, (tab.words / goal) * 100) : 0;
  const dups = duplicateHeadings(collectHeadings(text));
  const rows: Array<[string, string]> = [
    // 라벨에는 형식화 문구(t.f.words)를 쓰지 않는다 — 값 열과 숫자가 겹쳐
    // "단어 1,234개 | 1,234"로 두 번 보였다.
    [t.statWords, tab.words.toLocaleString()],
    [t.statChars, tab.chars.toLocaleString()],
    [t.statParagraphs, String(paragraphs)],
    [t.tocTitle, String(headings)],
    [t.tbTable, String(Math.floor(tables))],
    ["Code", String(Math.floor(codeBlocks))],
    [t.statReading, `${readingMinutes(text)} ${t.statMin}`],
    [t.statSentences, String(sentences)],
    [t.statAvgSentence, `${avgSentenceLen.toFixed(1)} ${t.statCharsUnit}`],
    ...(goal > 0
      ? [[t.goalTitle, `${tab.words.toLocaleString()} / ${goal.toLocaleString()} (${Math.round(goalPct)}%)`] as [string, string]]
      : []),
    ...(dups.length > 0
      ? [[t.statDupHeadings, String(dups.length)] as [string, string]]
      : []),
  ];
  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-label={t.statsTitle} onClick={(e) => e.target === e.currentTarget && onClose()}>
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
        {goal > 0 && (
          <div className="goal-progress">
            <div className="goal-bar">
              <div className={`goal-fill ${tab.words >= goal ? "is-done" : ""}`} style={{ width: `${goalPct}%` }} />
            </div>
            <div className="goal-label">
              {tab.words.toLocaleString()} / {goal.toLocaleString()} {t.goalWords}
            </div>
          </div>
        )}
        {sentences > 0 && (
          <div className="sentence-dist">
            <div className="sidebar-subtitle">{t.statSentenceDist}</div>
            {bucketRows.map(([label, n, cls]) => (
              <div key={cls} className="sd-row">
                <span className="sd-label">{label}</span>
                <span className="sd-bar-wrap">
                  <span className={`sd-bar ${cls}`} style={{ width: `${(n / bucketMax) * 100}%` }} />
                </span>
                <span className="sd-count">{n}</span>
              </div>
            ))}
            <div className="sd-note">
              {t.statLongMost} {sls.longest}{t.statCharsUnit}
              {sls.longCount > 0 && ` · ${sls.longCount} ${t.statLongWarn}`}
            </div>
            {longSentences.length > 0 && (
              <div className="sd-long-list">
                {longSentences.map((ls, i) => (
                  <button
                    key={`${ls.pos}-${i}`}
                    className="sd-long-item"
                    title={ls.text}
                    onClick={() => {
                      const view = store.view;
                      if (!view) return;
                      onClose();
                      const fmLen = text.length - body.length; // 프런트매터 오프셋 보정
                      smoothScrollIntoView(view, Math.min(ls.pos + fmLen, view.state.doc.length));
                    }}
                  >
                    <span className="sd-long-num">{i + 1}</span>
                    <span className="sd-long-text">{ls.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
