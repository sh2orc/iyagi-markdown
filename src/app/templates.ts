// 문서 템플릿 — 새 문서를 자주 쓰는 형식으로 시작.
// 원문 보존과 무관: 단순히 초기 버퍼 텍스트로 삽입하는 것뿐이다.
// content는 한국어 골격, contentEn은 영어 골격(없으면 content 사용).

export interface DocTemplate {
  id: string;
  nameKo: string;
  nameEn: string;
  content: string;
  contentEn?: string;
}

const today = () => new Date().toISOString().split("T")[0];

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    nameKo: "빈 문서",
    nameEn: "Blank",
    content: "",
  },
  {
    id: "report",
    nameKo: "보고서",
    nameEn: "Report",
    content: `---
title: 제목
date: ${today()}
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
date: ${today()}
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
    content: `---
title: 회의록
date: ${today()}
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
date: ${today()}
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
    content: `---
title:
date: ${today()}
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
date: ${today()}
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
    content: `---
title:
date: ${today()}
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
date: ${today()}
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
];
