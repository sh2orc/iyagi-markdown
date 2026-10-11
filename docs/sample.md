# IYAGI Markdown — 기능 둘러보기

이 문서는 앱의 모든 렌더링 기능을 한 번에 보여 주는 샘플이다. **굵게**, *기울임*, ~~취소선~~, `인라인 코드`를 포함하고 [외부 링크](https://example.com)와 [내부 문서 링크](sample-kr.md)도 있다.

## 기본 블록

> 인용문은 왼쪽 막대로 표시된다. 커서를 올리면 원문이 나타난다.

- 목록 항목 하나
- 목록 항목 둘
  - 중첩 항목
- [ ] 작업: 할 일
- [x] 작업: 끝낸 일

1. 순서 목록
2. 두 번째 항목

---

## 표 (GFM)

| 기능 | 상태 | 비고 |
|:-----|:----:|----:|
| 라이브 프리뷰 | ✅ | 커서 줄만 원문 |
| 표 위젯 | ✅ | 정렬 유지 |
| 수식 | ✅ | KaTeX |
| 다이어그램 | ✅ | mermaid |

## 코드 블록

```rust
fn main() {
    // 구문 강조는 중첩 파서가 담당한다.
    let greeting = "안녕, 마크다운";
    println!("{greeting}");
}
```

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

## 수식 (KaTeX)

인라인 수식 $E = mc^2$와 디스플레이 수식:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

## 다이어그램 (mermaid)

```mermaid
flowchart LR
    A[마크다운 파일] --> B{라이브 프리뷰}
    B -->|읽기 모드| C[전체 렌더]
    B -->|편집 모드| D[커서 블록만 원문]
    C --> E[저장 = 원문 그대로]
    D --> E
```

```mermaid
sequenceDiagram
    participant U as 사용자
    participant A as 앱
    participant F as 파일시스템
    U->>A: 파일 열기
    A->>F: 바이트 그대로 읽기
    F-->>A: 텍스트 + BOM/CRLF 메타
    A-->>U: 라이브 프리뷰
    U->>A: 저장 (⌘S)
    A->>F: 원자적 쓰기 (임시 파일 → rename)
```

## 이미지

![앱 아이콘](../src-tauri/icons/icon-source.png)

## 줄 바꿈과 원문 보존

마지막 줄에 개행이 없는 문서도 그대로 보존된다. 저장은 언제나 버퍼 텍스트 그대로다.
