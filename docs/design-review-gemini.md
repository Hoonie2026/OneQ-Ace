# 원큐합격(OneQ-Ace) 모바일 UX/UI 디자인 점검 및 개선안

- **대상 버전**: `app/` v0.8.4 (React PWA, 기사·산업기사 필기 기출 학습앱)
- **설계 전제(유지 사항 — ADR 014 7~10절)**:
  - 합격 가능성(%) 미표시, `"계획 수정 필요"` 배지 미표시
  - 시험일 예상 점수 3단계 색상 기준 유지(`60점 미만` 빨강 · `75점 미만` 주황 · `75점 이상` 초록)
  - 학습계획 접근 경로는 홈 시험일 아래 `"학습계획 설정(재설정)"`(› 없음, 한 줄 고정) 한 곳으로 일원화
  - 학습 원리 접근 경로는 홈 맨 아래 `"📘 학습 원리 · 예상 점수 계산 방법"` 단추 하나로 일원화
  - 예상 점수 계산 보기는 두괄식·개조식 + 출제 유형 막대 그림 + 표 단위 `"점(100점 만점)"` 통일 + 산식 아래 `"계산 근거"` 상자(실측/검증 초록 · 가정값 주황, 오차 범위 명시) 구조 유지
  - 풀이 중 `✕` 선택 창(`[나중에 이어서 하기]` / `[오늘 학습 마치기]` / `[계속 풀기]`) 및 풀이 중 `"📊 성적"` → 뒤로가기 시 풀이 복귀 흐름 유지

---

## 1. 점검 관점별 핵심 진단 요약 (개조식)

- **① iOS·안드로이드 플랫폼 차이**
  - `index.html`의 `apple-mobile-web-app-status-bar-style="black-translucent"` 고정으로 iOS 홈 화면 앱(standalone) 라이트 모드(`#f4f6f9`)에서 흰색 상태표시줄 글자·아이콘이 보이지 않음(명도 대비 `1.09:1`).
  - `<meta name="theme-color" content="#0f1d2e" />` 단일 고정으로 라이트 모드 Android Chrome에서도 상단 시스템 바만 어두운 남색으로 분리됨.
  - 상단 배너(`.top-banners`) 표출 시 배너와 `.app` 양쪽에 `env(safe-area-inset-top)`이 중복 합산되어 iOS 노치/다이내믹 아일랜드 기기에서 상단 여백이 `94~118px`로 과도하게 벌어짐.
  - 풀이 화면 하단(`.solve-bottom`) 패딩이 `calc(env(safe-area-inset-bottom) + 10px)`뿐이어서 `safe-area-inset-bottom`이 `0px`인 Android 제스처 내비게이션 환경 및 iOS 홈 인디케이터 영역에서 `"다음 →"`·`"모름"` 단추 오터치·스와이프 간섭 발생.
  - `<input type="date">`에 `-webkit-appearance: none`이 없어 iOS Safari에서 입력칸 높이와 텍스트 정렬이 Android와 다르게 깨짐.
- **② 가독성 (50대 이상 수험생 · 큰 글씨 설정 기준)**
  - `html, body { font-size: 16px }` 및 전 컴포넌트 `px` 단위 고정으로 사용자가 iOS(유동적 글자 크기)·Android(글자 크기 115~130%) 시스템 설정을 키워도 앱 글씨가 반응하지 않음.
  - `11px`(`.mini-table th.nowrap`, `.basis .lv`, `.bar-line.now em`) 및 `12px`(`.solve-meta span`, `.foot`, `.kv dt`, `.diag`, `.tag`) 등 50대 이상 노안 학습자가 판독하기 어려운 미세 글자가 다수 존재.
  - 계산 근거(`.basis dd`, `13.5px`), 추천 사유(`details.why ul`, `14px`) 등 설명문 줄 간격(`1.45~1.55`)과 문단 간격이 좁아 긴 한글 문장 가독성이 떨어짐.
- **③ 터치 영역 및 오터치 위험**
  - 풀이 화면 상단 좌측에 `✕`(풀이 멈추고 홈으로, `48×48px`)와 `‹`(이전 문항, `48×48px`)가 불과 `4px` 간격으로 붙어 있어 이전 문항을 보려다 `✕`를 누르는 오터치 위험이 매우 높음.
  - 홈 `"계산 보기 ›"`(`~28px`), 홈 `"오늘 학습 마치기 ›"`(`~26px`), 풀이 화면 `"n회 출제"` 배지(`~26px`), `"✎ 메모 쓰기"`·`"🔎 웹검색"` 칩(`36px`), 문제 그림 확대 `−`/`+` 단추(`40×40px`) 등이 Apple HIG(`44×44pt`) 및 Material 3(`48×48dp`) 최소 터치 기준에 미달.
- **④ 색·대비 (WCAG 2.1 AA · 다크 모드 · 색각 이상)**
  - 라이트 모드에서 초록 배경(`--ok-bg: #e5f5ec`) 위 초록 글자(`--ok: #138a4e`)의 명도 대비가 **`3.90:1`**로 WCAG AA 일반 텍스트 기준(`4.5:1`) 미달.
  - 예상 점수 계산 보기의 출제 유형 큰 막대(`.share-bar.big span`) 글자가 `#ffffff`로 고정되어, 다크 모드에서 변형 문항(`--memo: #b99cff`) 위 흰 글자 대비가 **`1.89:1`**, 같은 문항(`--primary: #5b93ff`) 위 흰 글자 대비가 **`2.94:1`**, 라이트 모드 신규 문항(`--idle: #8a97a8`) 위 흰 글자 대비가 **`2.97:1`**로 모두 WCAG AA(`4.5:1`) 미달.
  - 과목별 학습 막대의 노란색(`.bar-fill.warn { background: #e0a400 }`)이 막대 트랙(`--line: #dde3ea`) 대비 **`1.73:1`**, 흰 배경 대비 **`2.22:1`**로 비텍스트 그래픽 대비 기준(WCAG 1.4.11 `3.0:1`) 미달.
  - 다크 모드에서 문제 그림 배경(`--paper: #ffffff`)이 감광 없이 순백색으로 출력되어 어두운 배경(`#0b1420`)과 극단적 휘도 차이로 눈부심(Halation) 유발.
- **⑤ 일관성 (단추·카드·제목·아이콘·여백)**
  - 홈 내부 하위 보기(`RecommendView`, `SubjectList`, `MockPanel`, `ForecastView`, `Principles`)는 알약형 `"← 홈"` 단추(`.back-btn`, 높이 `40px`, 파란 테두리)를 쓰는 반면, 독립 화면(`PlanSetup`, `DaySummary`, `Result`, `Settings`, `PackDetail`)은 투명 아이콘 `"‹"`(`.icon-btn`, `48×48px`)만 사용하여 뒤로가기 형태와 시인성이 불일치.
  - 홈과 학습 계획 미리보기는 예상 점수에 3단계 색상(`60 미만` 빨강 · `75 미만` 주황 · `75 이상` 초록)을 쓰나, 오늘 학습 마침(`DaySummary`)은 2단계 색상(빨강/초록)만 쓰고 `.score-pair`에 `.warn` 스타일이 누락되어 같은 점수라도 화면마다 색이 다름.
- **⑥ 학습 몰입 및 한 손 조작**
  - 풀이 화면(`height: 100dvh; overflow: hidden`)에서 정답 확인 후 `"✎ 메모 쓰기"`를 누르면 가상 키보드가 올라오면서 문제 그림 영역(`.zoom`)이 `0px`로 찌그러지거나 메모 입력창이 가려짐.
  - 문제 그림 하단 우측에 떠 있는 확대 도구(`.zoom-tools`)가 긴 지문이나 우측 하단 보기를 가릴 수 있어 `.zoom-box` 내부 하단 여유 패딩이 필요함.

---

## 2. 화면별 상세 점검 및 개선안

### 2-1. 전역 레이아웃 · 시스템 연동 (`index.html`, `styles.css`, `App.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| `apple-mobile-web-app-status-bar-style="black-translucent"` 고정으로 라이트 모드 홈 화면 앱에서 흰색 상태표시줄(시계·배터리)이 배경(`#f4f6f9`)에 묻혀 보이지 않음 | Apple HIG — Status Bars (배경 밝기에 맞는 상태표시줄 명도 대비 확보) / WCAG 1.4.3 Contrast (Minimum) | • `index.html`의 `apple-mobile-web-app-status-bar-style`을 `"default"`로 변경<br>• `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f6f9" />` 및 `media="(prefers-color-scheme: dark)" content="#0b1420"` 2개로 분리 | **상** | iOS / Android |
| 상단 배너(`.top-banners`)가 뜰 때 `.banner`와 `.app` 양쪽에 `env(safe-area-inset-top)`이 중복 적용되어 상단 여백이 2배로 벌어짐 | Apple HIG — Layout and Safe Areas (Safe Area Inset 중복 합산 금지) | • `styles.css`에 `.top-banners:not(:empty) + .app { padding-top: 12px; }` 추가하여 배너가 있을 때는 `.top-banners`에서만 `env(safe-area-inset-top)`을 소비하도록 수정 | **중** | iOS |
| 라이트 모드 `--ok`(`#138a4e`) 글자가 `--ok-bg`(`#e5f5ec`) 배경 위에 쓰일 때 명도 대비가 `3.90:1`로 기준 미달 (`.verdict.ok`, `.tag.app`, `.basis .lv.ok`, `.report.ok`) | WCAG 2.1 AA — 1.4.3 Contrast (Minimum) (일반 텍스트 최소 `4.5:1` 이상) | • `:root`의 `--ok`를 `#138a4e` → **`#0e7440`**으로 변경 (`#e5f5ec` 대비 **`5.05:1`**, `#ffffff` 대비 **`5.74:1`** 확보) | **상** | 공통 |
| 모든 글자 크기가 `px`로 고정되어 기기 OS의 '글자 크기 확대' 설정이 반영되지 않으며, 50대 이상에게 버거운 `11~12px` 텍스트가 다수 존재 | Apple HIG — Typography (Dynamic Type) / Material 3 — Accessibility (Font Scaling) / WCAG 1.4.4 Resize Text | • `html { font-size: 100%; }` 유지 후 주요 폰트 크기를 `rem` 기준으로 전환하거나 `clamp()` 병행<br>• 앱 내 최소 글자 크기를 **`13px`(`0.8125rem`)** 이상으로 상향 (`.foot`, `.kv dt`, `.diag`, `.tag` 등 `12px` → **`13px`**, 보조 설명 `13px` → **`14px`**) | **중** | 공통 |
| 화면별 뒤로가기 단추가 홈 내부 보기(`.back-btn`: `← 홈` 알약형, 높이 `40px`)와 독립 화면(`.page-head .icon-btn`: `‹` 투명 아이콘, `48×48px`)으로 이원화됨 | Apple HIG — Navigation / Material 3 — Top App Bar / WCAG 3.2.4 Consistent Identification | • 모든 하위 화면 머리의 뒤로가기를 `.back-btn` 알약형 스타일로 통일하되, 높이를 `40px` → **`min-height: 44px; padding: 0 14px 0 12px; font-size: 15px;`**로 키워 터치 기준 충족 | **중** | 공통 |

---

### 2-2. 홈 화면 (`Home.tsx`, `CoachCard.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| 시험일 예상 점수 카드(`.score-box`)의 `"계산 보기 ›"` 단추(`.link-btn.small`) 높이가 약 `26px`(`padding: 4px 0`)로 작아 50대 이상 사용자가 정확히 누르기 어려움 | Apple HIG — Touch Targets (최소 `44×44pt`) / Material 3 — Touch Targets (`48×48dp`) / WCAG 2.5.8 Target Size | • `.score-box .link-btn.small`에 **`min-height: 44px; padding: 8px 10px; margin: 0 -10px -6px; display: inline-flex; align-items: center; font-size: 15px; font-weight: 700;`** 적용 | **상** | 공통 |
| 오늘 학습 목표 카드 하단 `"오늘 학습 마치기 ›"`(`.link-btn.center-link`)의 높이가 `26px`이고 위쪽 `"과목별 학습 ›"` 단추와 `10px` 간격으로 붙어 있어 오터치 위험이 큼 | Apple HIG — Touch Targets (`44×44pt`) / Material 3 — Spacing between targets (`≥ 8dp`) | • `.center-link`에 **`min-height: 44px; padding: 8px 16px; font-size: 15px; display: inline-flex; align-items: center;`** 적용 | **상** | 공통 |
| 시험일 예상 점수 상태(`60 미만` 빨강 · `75 미만` 주황 · `75 이상` 초록)가 숫자 색상만으로 전달되어 적록 색각 이상자나 야외 저휘도 환경에서 구분이 어려움 (배지·합격 가능성 % 미표시 규칙 준수 필요) | WCAG 2.1 A — 1.4.1 Use of Color (색상만으로 상태 전달 지양) | • 배지나 문구를 추가하지 않고, `.score-box.bad / .warn / .ok` 카드 상단에 상태별 굵은 보더·패턴을 추가:<br>  - `.score-box.bad`: **`border-top: 4px solid var(--fail);`** (`#c62f2f`)<br>  - `.score-box.warn`: **`border-top: 4px solid var(--check);`** (`#a15c00`)<br>  - `.score-box.ok`: **`border-top: 4px solid var(--ok);`** (`#0e7440`) | **중** | 공통 |
| `.exam-row` 안에서 왼쪽 `.exam-date`(버튼)와 오른쪽 `.exam-dday`(단순 표시)가 동일한 회색 상자(`#f4f6f9`, `border-radius: 12px`)로 그려져 D-day 상자를 눌러도 반응할 것처럼 오인됨 | Material 3 — States & Affordance (클릭 가능 요소와 정적 요소의 시각적 구분) | • `.exam-date`에 **`border: 1px solid color-mix(in srgb, var(--primary) 28%, var(--line));`** 및 **`:active { background: var(--line); }`** 터치 피드백 부여 (또는 `.exam-row` 전체를 클릭 영역으로 통합) | **하** | 공통 |
| 학습 점검 카드(`.insight-card`) 내 목록(`ul`)의 과목명이 길게 나열될 때(`측지학 및 위성측위시스템, 응용측량...`) 줄바꿈이 어색하게 끊김 | Material 3 — Typography (한글 단어 단위 줄바꿈 가독성) | • `.insight-card ul`에 **`word-break: keep-all; line-height: 1.55; gap: 6px;`** 추가 | **하** | 공통 |

---

### 2-3. 풀이 화면 · 문제 그림 확대 (`Solve.tsx`, `ZoomImage.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| 상단 바 좌측에 `✕`(나가기)와 `‹`(이전 문항) `48×48px` 단추 2개가 불과 `4px` 간격으로 붙어 있어, 이전 문항을 보려다 `✕`를 눌러 학습 흐름이 끊길 위험이 매우 높음 | Apple HIG — Ergonomics & Touch Targets / Material 3 — Component Spacing (파괴적·이탈 동작과 탐색 동작 분리) | • `.solve-top`에서 `✕`와 `‹` 사이 간격을 넓히고 `‹` 단추에 라벨과 테두리를 부여해 시각적으로 분리:<br>  - `‹` 단추를 **`min-height: 40px; padding: 0 12px; margin-left: 6px; border: 1px solid var(--line); border-radius: 20px; font-size: 15px; font-weight: 700;`** (`‹ 이전`) 형태로 변경 | **상** | 공통 |
| `.solve-bottom` 하단 패딩이 `calc(env(safe-area-inset-bottom) + 10px)`뿐이라 Android 제스처 바(`inset=0px`) 및 iOS 홈 인디케이터와 `"다음 →"`·`"모름"`·`"🔎 웹검색"` 단추가 너무 가까워 스와이프 오작동 발생 | Apple HIG — Home Indicator Safe Area / Material 3 — Gesture Navigation Bar Inset | • `.solve-bottom` 패딩을 **`padding: 10px 14px calc(max(env(safe-area-inset-bottom), 14px) + 10px);`**로 변경하여 Android에서도 최소 `24px`, iOS에서는 `44px+`의 하단 여유 확보 | **상** | iOS / Android |
| 다크 모드에서 문제 이미지 배경(`--paper: #ffffff`)이 순백색 그대로여서 어두운 화면(`#0b1420`)과 대비가 너무 강해 야간 학습 시 눈부심(Halation) 발생 | Material 3 — Dark Theme (고휘도 순백색 이미지 표면 감광 권장) | • `@media (prefers-color-scheme: dark)`에서 `--paper: #eceff4;`로 낮추고, `.zoom-inner img`에 **`filter: brightness(0.92) contrast(1.04);`** 적용 | **상** | 공통 |
| 정답 확인 후 `"✎ 메모 쓰기"`를 눌러 `<textarea className="note">`에 포커스될 때 모바일 가상 키보드가 올라오면서 `100dvh` 고정 레이아웃 안의 문제 그림(`.zoom`)이 `0px`로 찌그러지고 입력창이 가려짐 | Apple HIG — Onscreen Keyboards / Material 3 — Keyboard Inset & Scroll | • `.feedback`에 **`max-height: 44dvh; overflow-y: auto;`** 추가<br>• 메모 입력(`noteOpen === true`) 중일 때 `.solve:has(.note:focus) .choices`를 **`display: none;`**(또는 `.choice { min-height: 40px; font-size: 20px; }`)으로 축소해 문제 그림과 메모창 시야 확보 | **상** | iOS / Android |
| 문제 그림 우측 하단 확대 단추(`.zoom-btn`)가 `40×40px`(`gap: 6px`)로 작고, 확대하지 않은 기본 상태에서도 그림 우측 하단(보기 ④번 끝 등)을 가릴 수 있음 | Apple HIG (`44×44pt`) / Material 3 (`48×48dp`) / WCAG 2.5.8 Target Size | • `.zoom-btn`을 **`min-width: 44px; height: 44px; gap: 8px; border-radius: 22px;`**로 확대<br>• `.zoom-box`에 **`padding: 8px 8px 56px;`**를 주어 끝까지 스크롤하면 이미지가 확대 단추 위로 올라오게 처리 | **중** | 공통 |
| 피드백 영역의 `"✎ 메모 쓰기"`·`"🔎 웹검색"`(`.chip-btn`, 높이 `36px`)과 상단 `"n회 출제"` 배지(`.freq-badge`, 높이 `~26px`)의 터치 영역이 작음 | Apple HIG (`44×44pt`) / Material 3 (`48×48dp`) | • `.chip-btn`: **`min-height: 44px; padding: 0 14px; border-radius: 22px; font-size: 15px; font-weight: 600;`**<br>• `.freq-badge`: **`min-height: 36px; padding: 6px 12px; font-size: 14px;`** | **중** | 공통 |
| 보기 단추(`.choice`)의 원문자(`①②③④`, `26px`)가 iOS/Android 시스템 폰트마다 원 안쪽 숫자 크기가 작고, 채점 후 정답(초록)·오답(빨강)이 색상만으로 구분됨 | WCAG 1.4.1 Use of Color / 50대 이상 시인성 | • `.choice.is-answer`와 `.choice.is-chosen`에 두께 차이(**`border-width: 3px;`**) 및 우측 상단 작은 상태 기호(`::after`로 정답 **`✓`**, 오답 **`✕`**, `font-size: 13px; position: absolute; top: 4px; right: 8px;`) 추가 (`position: relative` 지정) | **중** | 공통 |
| 상단 출제처·과목 정보(`.solve-meta span`)가 `12px`에 한 줄 말줄임(`ellipsis`) 처리되어 긴 과목명(`측지학 및 위성측위시스템`)이 잘리고 읽기 어려움 | 50대 이상 가독성 기준 | • `.solve-meta span` 글자 크기를 `12px` → **`13.5px`**로 키우고 `color: var(--ink); opacity: 0.78;`로 명도 개선 | **하** | 공통 |

---

### 2-4. 예상 점수 계산 보기 (`ForecastView.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| 출제 유형 큰 막대(`.share-bar.big span`)의 글자 색이 `#ffffff`로 고정되어, 다크 모드에서 변형 문항(`#b99cff`) 위 흰 글자 대비가 **`1.89:1`**, 같은 문항(`#5b93ff`) 위 **`2.94:1`**, 라이트 모드 신규 문항(`#8a97a8`) 위 **`2.97:1`**로 모두 미달 | WCAG 2.1 AA — 1.4.3 Contrast (Minimum) (`14px` 굵은 글씨 최소 `4.5:1` 이상) | • 라이트 모드 `--idle`(신규 문항 막대)을 `#8a97a8` → **`#5c6b7d`**(`#ffffff` 대비 **`5.41:1`**)로 변경<br>• 다크 모드에서 `.share-bar.big span`의 글자 색을 `#ffffff` → **`var(--primary-ink)`(`#08111d`)**로 변경하고, 다크 모드 `--idle`을 **`#8fa0b5`**(`#08111d` 대비 **`6.8:1`**)로 조정 | **상** | 공통 |
| 과목별 예상점수 표 머리(`.mini-table th.nowrap`)가 한 줄 유지를 위해 **`11px`**로 축소되어 50대 이상 수험생이 항목명(`기출문항 점수 / 신규문항 점수 / 시험예상 점수`)을 읽기 힘듦 | 50대 이상 가독성 기준 (최소 `13px` 이상 권장) / Apple HIG — Typography | • 한 줄 표기 규칙(ADR 014 10절)을 유지하면서 `.mini-table th.nowrap`을 **`font-size: clamp(12.5px, 3.4vw, 13.5px); letter-spacing: -0.04em; color: var(--ink); padding: 8px 3px;`**로 키워 가독성 확보<br>• 표 본문(`.mini-table td`)도 `14px` → **`15px`**, `padding: 9px 4px;`로 확대 | **상** | 공통 |
| 계산 근거 상자(`.basis`)의 설명문(`dd: 13.5px`)과 근거 수준 배지(`.lv: 11px`) 글씨가 작고 항목 간 간격이 좁아 긴 수식·모형 설명을 읽을 때 피로도가 높음 | 50대 이상 가독성 기준 | • `.basis dt`: `margin-top: 14px; font-size: 15.5px;`<br>• `.basis dd`: **`font-size: 14.5px; line-height: 1.6; color: var(--ink); opacity: 0.88;`**<br>• `.basis .lv`: **`font-size: 12.5px; padding: 2px 8px;`**<br>• `.basis .err ul`: **`font-size: 14.5px; line-height: 1.6;`** | **중** | 공통 |

---

### 2-5. 시스템 추천 학습 · 과목별 학습 (`RecommendView.tsx`, `SubjectList.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| 과목별 학습 막대의 노란색(`.bar-fill.warn { background: #e0a400 }`)이 트랙(`#dde3ea`) 대비 **`1.73:1`**, 흰 배경(`#ffffff`) 대비 **`2.22:1`**로 막대 끝 위치가 흐릿하게 보임 | WCAG 2.1 AA — 1.4.11 Non-text Contrast (그래픽·상태 막대 최소 `3.0:1` 이상) | • `.bar-fill.warn` 배경을 `#e0a400` → **`#b87d00`**(라이트 모드 흰 배경 대비 **`3.52:1`**, 다크 모드에서는 `#ffbe5c`로 분기하여 어두운 트랙 `#26384f` 대비 **`6.9:1`**)으로 변경 | **상** | 공통 |
| 과목별 학습 막대 위 `"예상 n"` 라벨(`.bar-mark em`)이 `transform: translateX(-50%)`로 배치되어 예상 점수가 `0~8점`이거나 `92~100점`일 때 카드 좌우 밖으로 잘리거나 삐져나감 | Material 3 — Layout & Overflow | • `SubjectList.tsx`는 그대로 두고 `styles.css`에서 `.bar.dual`에 좌우 여백을 보완하거나 `.bar-mark em`에 **`font-size: 12.5px; background: var(--surface); padding: 0 3px; border-radius: 4px;`**를 주어 과락선 점선과 겹쳐도 숫자가 선명히 읽히게 개선 | **중** | 공통 |
| 과목별 카드 우측 하단 `"학습하기 (n문항)"` 단추가 `.btn-small`(높이 `40px`, 글자 `14px`)로 되어 있어 주요 학습 시작 단추임에도 터치 영역이 작음 | Apple HIG (`44×44pt`) / Material 3 (`48×48dp`) | • `.subject-foot .btn-small`에 **`min-height: 46px; padding: 0 16px; font-size: 15px; flex: none;`** 적용 | **중** | 공통 |
| 추천 화면의 `"왜 이렇게 구성했나요?"`(`details.why summary`)가 `display: flex`로 인해 iOS Safari에서 기본 삼각형 마커가 사라져 펼침/접힘 여부가 직관적이지 않고 높이가 `40px`로 낮음 | Apple HIG — Disclosure Controls (`44pt` 이상 및 명확한 방향 표시) | • `details.why summary`에 **`min-height: 48px; padding: 0 12px; border-radius: 10px; background: var(--bg); justify-content: space-between;`** 적용 및 `summary::after { content: '▾'; font-size: 16px; }`, `details.why[open] summary::after { content: '▴'; }` 추가 | **중** | iOS / 공통 |

---

### 2-6. 학습 계획 · 모의고사 · 성적 · 설정 (`PlanSetup.tsx`, `MockPanel.tsx`, `Result.tsx`, `DaySummary.tsx`, `Settings.tsx`)

| 문제점 | 근거(Apple HIG / Material 3 / WCAG 항목) | 개선안(구체 수치: px, 색 코드) | 우선순위 | 영향 기기 |
|---|---|---|---|---|
| iOS Safari에서 `<input type="date">`의 기본 외형이 유지되어 높이가 줄어들거나 글자가 위/왼쪽으로 치우치며, `.day-add` 줄의 입력칸(`48px`)과 `[추가]` 단추(`40px`) 높이가 어긋남 | Apple HIG — Date Pickers & Text Fields (일관된 입력 컨트롤 높이 `44~48pt`) | • `.field input, .day-add input`에 **`-webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; min-height: 48px;`** 추가<br>• `.day-add .btn-small` 및 `.day-list .btn-small` 높이를 **`min-height: 48px; padding: 0 14px;`**로 통일하고 `.day-list` 행 간격을 `gap: 4px` → **`gap: 8px`**로 확대 | **상** | iOS / 공통 |
| 오늘 학습 마침(`DaySummary`)의 `"계획 이행 시"` 예상 점수가 2단계 색상(`bad`/`ok`)만 쓰고 `.score-pair .warn b`가 정의되지 않아 홈·학습계획의 3단계 색상(60/75 기준)과 불일치 | WCAG 3.2.4 Consistent Identification / ADR 014 7절 (예상 점수 색 60/75 기준 통일) | • `styles.css`에 **`.score-pair .warn b { color: var(--check); }`** 추가 (60점 이상 75점 미만일 때 주황색 일관 표시) | **중** | 공통 |
| 모의고사 성적 이력 표(`.history tr.clickable`)를 눌러야 상세 성적이 열리는데, 행 높이가 약 `34px`(`padding: 6px 4px`)로 좁고 터치 가능하다는 시각적 단서(`›`)가 전혀 없음 | Apple HIG (`44pt`) / Material 3 — Lists & Tables (행 터치 어포던스) | • `.history th, .history td`의 패딩을 **`padding: 12px 6px; font-size: 15px;`**(행 높이 `≥ 48px`)로 확대<br>• `.history tr.clickable td:last-child::after { content: ' ›'; color: var(--muted); font-weight: 700; }` 및 `tr.clickable:active { background: var(--bg); }` 추가 | **중** | 공통 |
| 성적 화면(`Result.tsx`) 과목별 점수 막대(`.bar`)에서 과락선(`40`)과 평균선(`60`)이 둘 다 `2px` 실선(투명도 `0.55` vs `0.3`)으로만 표시되어 과목별 학습(`SubjectList`)의 점선 과락선과 다르고 식별이 어려움 | WCAG 1.4.11 Non-text Contrast / 화면 간 시각 언어 일관성 | • `.bars .bar-line:not(.avg)`를 `SubjectList`와 동일하게 **`width: 0; background: none; border-left: 2px dashed var(--fail); opacity: 0.85;`**로 변경하여 과락선(점선)과 평균선(실선)을 명확히 구분 | **중** | 공통 |
| 설정 화면의 문제팩 목록(`.pack-lines`)이 30회차 이상일 때 스크롤 제한 없이 약 `1,600px` 이상 늘어져 아래쪽 `'자격종목 관리'`와 `'이 기기 데이터 지우기'` 탐색이 불편함 | Material 3 — Scrolling & Container Bounds | • `.pack-lines`에 **`.check-list`와 동일하게 `max-height: 300px; overflow-y: auto; padding-right: 2px;`**를 부여해 카드 높이를 제어 | **하** | 공통 |
| 설정 데이터 지우기에서 `'전체 선택'`(`.check-line.all`, `padding: 0 4px`)과 개별 회차(`.check-line`, `padding: 0 12px`)의 좌측 패딩이 달라 체크박스 세로열이 `8px` 어긋남 | Material 3 — Alignment & Keylines | • `.check-line.all`의 패딩을 `padding: 0 4px` → **`padding: 0 12px`**로 통일 | **하** | 공통 |

---

## 3. 바로 적용 추천 10개 (우선순위 순 · CSS/메타 태그 중심 즉시 개선)

기능·용어·화면 구조를 전혀 바꾸지 않고 `app/index.html`과 `app/src/styles.css` 수정만으로 iOS·Android 실기기 체감 품질을 즉시 높일 수 있는 상위 10개 항목입니다.

1. **[iOS/Android 상태표시줄 & 테마색] `index.html` 상태표시줄 가시성 복구**
   - `apple-mobile-web-app-status-bar-style`을 `"black-translucent"` → **`"default"`**로 변경하고, `<meta name="theme-color">`를 라이트(`#f4f6f9`)·다크(`#0b1420`) 미디어 쿼리로 분리해 iOS 라이트 모드에서 흰색 시계·배터리가 사라지는 현상 해결.
2. **[풀이 화면 하단 제스처 바 보호] `.solve-bottom` 하단 안전 여백 확대**
   - `padding: 10px 12px calc(env(safe-area-inset-bottom) + 10px)` → **`padding: 10px 14px calc(max(env(safe-area-inset-bottom), 14px) + 10px)`**로 변경해 Android 하단 제스처 바와 iOS 홈 인디케이터 오터치 방지.
3. **[풀이 화면 상단 오터치 방지] `✕`(나가기)와 `‹`(이전 문항) 단추 간격 분리**
   - `.solve-top`의 두 아이콘 단추 사이 간격을 넓히고(`gap: 8px`), 두 번째 단추(`‹`)에 `border: 1px solid var(--line); background: var(--surface);`를 부여해 이전 문항을 보려다 `✕`를 누르는 실수 차단.
4. **[WCAG AA 명도 대비 해결 ①] 라이트 모드 초록색(`--ok`) 및 과목 막대 노란색(`.bar-fill.warn`) 보정**
   - `:root`의 `--ok`를 `#138a4e` → **`#0e7440`**(`--ok-bg` 대비 `3.90:1` → **`5.05:1`**)으로, `.bar-fill.warn`을 `#e0a400` → **`#b87d00`**(흰 배경 대비 `2.22:1` → **`3.52:1`**, 다크 모드는 `#ffbe5c`)으로 조정.
5. **[WCAG AA 명도 대비 해결 ②] 계산 보기 출제 유형 큰 막대(`.share-bar.big span`) 다크/라이트 대비 보정**
   - 라이트 모드 `--idle`을 `#8a97a8` → **`#5c6b7d`**(`#ffffff` 대비 `5.41:1`)로 변경하고, 다크 모드에서 `.share-bar.big span`의 글자 색을 **`var(--primary-ink)`(`#08111d`)**로 전환해 변형 문항 막대(`1.89:1` → `8.2:1`) 가독성 확보.
6. **[다크 모드 학습 눈부심 완화] 문제 그림(`.zoom-inner img`) 야간 감광 적용**
   - `@media (prefers-color-scheme: dark)`에 `--paper: #eceff4;` 및 `.zoom-inner img { filter: brightness(0.92) contrast(1.04); }`를 추가해 어두운 방에서 문제 그림이 눈을 찌르는 현상 해소.
7. **[홈 화면 터치 영역 확보] `"계산 보기 ›"` 및 `"오늘 학습 마치기 ›"` `44px` 터치 타깃 적용**
   - `.score-box .link-btn.small`과 `.today-card .center-link`에 **`min-height: 44px; display: inline-flex; align-items: center;`**와 음수 마진 보정을 적용해 카드 높이는 유지하면서 50대 이상 사용자의 터치 정확도 향상.
8. **[50대 이상 표·근거 가독성] 계산 보기 표 머리(`11px`) 및 계산 근거(`13.5px`) 크기 상향**
   - `.mini-table th.nowrap`을 `11px` → **`clamp(12.5px, 3.4vw, 13.5px)`**(`letter-spacing: -0.04em; color: var(--ink)`)로, `.basis dd`와 `.basis .err ul`을 `13.5px` → **`14.5px`**(`line-height: 1.6`)로 상향.
9. **[풀이 화면 키보드·확대 간섭 해결] 메모 입력 시 화면 찌그러짐 및 확대 단추 가림 방지**
   - `.feedback`에 `max-height: 44dvh; overflow-y: auto;`, `.zoom-box`에 `padding-bottom: 56px;`, `.zoom-btn`에 `min-width: 44px; height: 44px;` 적용.
10. **[iOS 날짜 입력 & 모의고사 이력 터치 개선] `input[type="date"]` 외형 정규화 및 `.history tr.clickable` 행 높이 `48px` 확대**
    - 입력칸에 `-webkit-appearance: none; appearance: none;` 적용, `.day-add .btn-small` 높이를 `48px`로 맞추고, 모의고사 성적 이력 표 행 패딩을 `12px 6px`으로 늘려 우측에 `›` 표시 추가.
