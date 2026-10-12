// 문서 템플릿 — 새 문서를 자주 쓰는 형식으로 시작.
// 원문 보존과 무관: 단순히 초기 버퍼 텍스트로 삽입하는 것뿐이다.

export interface DocTemplate {
  id: string;
  nameKo: string;
  nameEn: string;
  content: string;
}

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
date: ${new Date().toISOString().split("T")[0]}
tags: []
---

# 제목

## 개요

## 본문

## 결론

## 참고
- 
`,
  },
  {
    id: "meeting",
    nameKo: "회의록",
    nameEn: "Meeting Notes",
    content: `---
title: 회의록
date: ${new Date().toISOString().split("T")[0]}
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
  },
  {
    id: "blog",
    nameKo: "블로그",
    nameEn: "Blog Post",
    content: `---
title: 
date: ${new Date().toISOString().split("T")[0]}
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
  },
  {
    id: "dev",
    nameKo: "개발 노트",
    nameEn: "Dev Notes",
    content: `---
title: 
date: ${new Date().toISOString().split("T")[0]}
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
  },
];
