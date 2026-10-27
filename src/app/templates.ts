// 문서 템플릿 — 새 문서를 자주 쓰는 형식으로 시작.
// 원문 보존과 무관: 단순히 초기 버퍼 텍스트로 삽입하는 것뿐이다.
// content는 한국어 골격, contentEn은 영어 골격(없으면 content 사용).
import type { Lang } from "../i18n";

export interface DocTemplate {
  id: string;
  nameKo: string;
  nameEn: string;
  descriptionKo: string;
  descriptionEn: string;
  content: string;
  contentEn?: string;
}

// 로컬 날짜(YYYY-MM-DD) — toISOString은 UTC라 한국 시간 자정~오전 9시
// 사이에 만든 문서에 어제 날짜가 찍혔다.
const localDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function templateName(template: DocTemplate, lang: Lang): string {
  return lang === "ko" ? template.nameKo : template.nameEn;
}

export function templateDescription(template: DocTemplate, lang: Lang): string {
  return lang === "ko" ? template.descriptionKo : template.descriptionEn;
}

/** Resolve dates when creating a document, including after an overnight session. */
export function templateContent(template: DocTemplate, lang: Lang, now = new Date()): string {
  const source = lang === "en" ? template.contentEn ?? template.content : template.content;
  return source.replaceAll("{{date}}", localDate(now));
}

export function templateOutline(template: DocTemplate, lang: Lang): string {
  return templateContent(template, lang).split("\n").filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim()).filter(Boolean).slice(0, 4).join(" · ");
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    nameKo: "빈 문서",
    nameEn: "Blank",
    descriptionKo: "빈 문서에서 자유롭게 시작하세요.",
    descriptionEn: "Start with an empty document.",
    content: "",
  },
  {
    id: "report",
    nameKo: "보고서",
    nameEn: "Report",
    descriptionKo: "개요, 본문, 결론과 참고 자료를 정리합니다.",
    descriptionEn: "Organize an overview, findings, conclusions, and references.",
    content: `---
title: 제목
date: {{date}}
tags: []
---

# 제목

## 개요

## 본문

## 결론

## 참고
- 
`,
    contentEn: `---
title: Title
date: {{date}}
tags: []
---

# Title

## Overview

## Body

## Conclusion

## References
-
`,
  },
  {
    id: "meeting",
    nameKo: "회의록",
    nameEn: "Meeting Notes",
    descriptionKo: "안건, 결정사항과 후속 조치를 기록합니다.",
    descriptionEn: "Capture the agenda, decisions, and follow-up actions.",
    content: `---
title: 회의록
date: {{date}}
attendees: []
tags: [회의]
---

# 회의록 — 

**참석자**: 
**일시**: 

## 안건

### 안건 1

## 결정사항

- [ ] 

## 후속 조치

- [ ] 
`,
    contentEn: `---
title: Meeting Notes
date: {{date}}
attendees: []
tags: [meeting]
---

# Meeting Notes —

**Attendees**:
**Date**:

## Agenda

### Item 1

## Decisions

- [ ]

## Follow-ups

- [ ]
`,
  },
  {
    id: "blog",
    nameKo: "블로그",
    nameEn: "Blog Post",
    descriptionKo: "요약과 본문을 갖춘 글의 초안을 만듭니다.",
    descriptionEn: "Draft a post with a summary, main content, and closing.",
    content: `---
title:
date: {{date}}
tags: []
---

#

> 요약 문장.

## 서론

## 본론

## 마무리

---
*작성: *
`,
    contentEn: `---
title:
date: {{date}}
tags: []
---

#

> One-sentence summary.

## Introduction

## Body

## Closing

---
*Written by: *
`,
  },
  {
    id: "dev",
    nameKo: "개발 노트",
    nameEn: "Dev Notes",
    descriptionKo: "구현 배경, 코드와 참고 자료를 남깁니다.",
    descriptionEn: "Document the context, implementation, and references.",
    content: `---
title:
date: {{date}}
tags: [dev]
---

#

## 배경

## 구현

\`\`\`
\`\`\`

## 참고

- [ ]
`,
    contentEn: `---
title:
date: {{date}}
tags: [dev]
---

#

## Background

## Implementation

\`\`\`
\`\`\`

## References

- [ ]
`,
  },
  {
    id: "project", nameKo: "프로젝트 계획", nameEn: "Project Brief",
    descriptionKo: "목표, 범위, 일정과 위험 요소를 함께 정리합니다.",
    descriptionEn: "Define goals, scope, milestones, and risks.",
    content: "---\ntitle: 프로젝트 계획\ndate: {{date}}\ntags: [프로젝트]\n---\n\n# 프로젝트 계획\n\n## 목표\n\n## 범위\n\n### 포함 사항\n\n### 제외 사항\n\n## 일정과 담당자\n\n| 단계 | 담당자 | 목표일 | 상태 |\n| --- | --- | --- | --- |\n| 첫 번째 단계 | | | 예정 |\n\n## 위험 요소\n\n## 다음 할 일\n\n- [ ] \n",
    contentEn: "---\ntitle: Project Brief\ndate: {{date}}\ntags: [project]\n---\n\n# Project Brief\n\n## Goals\n\n## Scope\n\n### Included\n\n### Excluded\n\n## Milestones and owners\n\n| Milestone | Owner | Target date | Status |\n| --- | --- | --- | --- |\n| First milestone | | | Planned |\n\n## Risks\n\n## Next actions\n\n- [ ] \n",
  },
  {
    id: "weekly", nameKo: "주간 계획", nameEn: "Weekly Plan",
    descriptionKo: "이번 주의 우선순위, 할 일과 회고를 기록합니다.",
    descriptionEn: "Plan priorities and tasks, then reflect on the week.",
    content: "---\ntitle: 주간 계획\ndate: {{date}}\ntags: [계획]\n---\n\n# 주간 계획\n\n## 이번 주 우선순위\n\n1. \n2. \n3. \n\n## 할 일\n\n- [ ] \n\n## 일정\n\n| 요일 | 계획 |\n| --- | --- |\n| 월요일 | |\n| 화요일 | |\n| 수요일 | |\n| 목요일 | |\n| 금요일 | |\n\n## 회고\n\n### 잘된 점\n\n### 다음 주에 바꿀 점\n",
    contentEn: "---\ntitle: Weekly Plan\ndate: {{date}}\ntags: [planning]\n---\n\n# Weekly Plan\n\n## Priorities\n\n1. \n2. \n3. \n\n## Tasks\n\n- [ ] \n\n## Schedule\n\n| Day | Plan |\n| --- | --- |\n| Monday | |\n| Tuesday | |\n| Wednesday | |\n| Thursday | |\n| Friday | |\n\n## Reflection\n\n### What worked\n\n### What to change next week\n",
  },
  {
    id: "decision", nameKo: "의사결정 기록", nameEn: "Decision Record",
    descriptionKo: "선택지, 결정의 근거와 후속 영향을 남깁니다.",
    descriptionEn: "Record alternatives, the decision, and its consequences.",
    content: "---\ntitle: 의사결정 기록\ndate: {{date}}\nstatus: 검토 중\ntags: [결정]\n---\n\n# 의사결정 기록\n\n## 배경\n\n## 검토한 선택지\n\n| 선택지 | 장점 | 단점 |\n| --- | --- | --- |\n| 선택지 1 | | |\n| 선택지 2 | | |\n\n## 결정과 근거\n\n## 예상 영향\n\n## 후속 조치\n\n- [ ] \n",
    contentEn: "---\ntitle: Decision Record\ndate: {{date}}\nstatus: Proposed\ntags: [decision]\n---\n\n# Decision Record\n\n## Context\n\n## Alternatives considered\n\n| Option | Benefits | Drawbacks |\n| --- | --- | --- |\n| Option 1 | | |\n| Option 2 | | |\n\n## Decision and rationale\n\n## Consequences\n\n## Follow-up actions\n\n- [ ] \n",
  },
];
