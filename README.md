# OneQ-Ace (원큐합격)

기사·산업기사 **객관식 필기** 학습앱. 시험일까지 남은 기간과 진도를 분석해 학습량을 자동 계산하고, 기출을 반복해 과락과 미학습을 줄입니다.

> 이름 유래: **OneQ**(원큐, 한 번에) + **Ace**(에이스, A학점을 받듯 시험 통과) — "한 번에 에이스가 된다"

## 구성

| 폴더 | 내용 | 상태 |
|---|---|---|
| `app/` | 학습앱 — 정적 PWA (Vite + React + TypeScript). 스마트폰·태블릿·PC 브라우저 | **v0.10.7**(가져오기 진행 창, ADR 017): 학습 계획·시스템 추천·과목별 학습·모의고사·시험일 예상 점수(계산 보기)·학습 원리, [쉬움], 계산기·손글씨 메모, 백업/복원(기기 간 합치기). `src/engine/` 학습 엔진(FSRS) |
| `preprocessor/` | PC 기출 PDF 전처리기 `oneq-prep` (Python) | **v0.3.0 창 프로그램**(PySide6, 실행파일 `OneQ-Prep.exe`, 여러 회차 동시 처리·창 안 검수 — ADR 018) + 명령줄. 종목 프로필 측량·토목·건설안전(2026 기준, ADR 016). 동료용 안내 `docs/PREP-GUIDE.md` |
| `shared/` | 팩 포맷 스키마(`pack-schema.json`)·두 검증기 공용 시험 사례 | oqp/1 |
| `docs/` | 세션 기록, 실기기 결과표, 결정 기록(ADR), 사용 안내 초안(`USER-GUIDE.md`) | |

- 서버·DB·외부 API 없음. 모든 학습 기록은 기기 안에만 저장됩니다.
- 이 저장소에는 **앱 코드만** 있습니다. 기출 PDF·문항 이미지·문제팩은 커밋하지 않습니다(`.gitignore`).

## 개발 시작

```bash
cd app
npm install
npm run dev        # http://localhost:5173/OneQ-Ace/
npm run build      # dist/ 생성
npm test           # 단위 시험(vitest)
npm run e2e        # 모바일 에뮬레이션 게이트 시험(Playwright, 처음 한 번 `npx playwright install chromium`)
npm run gate       # 학습 엔진 게이트(가상 학습자 × 기간 × 시드, 화면의 시스템 추천 기준 — ADR 014)
```

`main` 브랜치에 푸시하면 GitHub Actions가 `app/`을 빌드해 GitHub Pages에 배포합니다.

## 스마트폰에서 설치하기

| 구분 | 주소 |
|---|---|
| **앱(여기서 설치)** | `https://hoonie2026.github.io/OneQ-Ace/` |
| 저장소(코드 보관, 설치 불가) | `https://github.com/Hoonie2026/OneQ-Ace` |

1. 스마트폰 **Chrome**(iPhone은 **Safari**) 주소창에 **앱 주소**를 입력합니다. 저장소 주소에서는 설치 메뉴가 나오지 않습니다.
2. Android: 오른쪽 위 **⋮ → 앱 설치**(또는 홈 화면에 추가) / iPhone: 공유 버튼 → **홈 화면에 추가**
3. 설치한 **「원큐합격」 아이콘**으로 엽니다. Android는 아이콘이 홈 화면이 아니라 **앱 화면(앱 서랍)**에만 생길 수 있습니다. 홈 화면에도 두려면 앱 화면에서 아이콘을 길게 눌러 **홈 화면에 추가**를 누릅니다.

앱 주소는 GitHub 저장소의 **Settings → Pages** 맨 위("Your site is live at …")에서도 확인할 수 있고, 앱 화면 아래 **앱 주소** 카드에서 복사·전송할 수 있습니다.

## 세션 규칙

모든 개발 세션은 [`docs/SESSION.md`](docs/SESSION.md)로 시작하고 끝냅니다. 개발 기준은 claude.ai 프로젝트의 「원큐합격 개발기준서」입니다.
