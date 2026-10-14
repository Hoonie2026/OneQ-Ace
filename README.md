# OneQ-Ace (원큐합격)

기사·산업기사 **객관식 필기** 학습앱. 시험일까지 남은 기간과 진도를 분석해 학습량을 자동 계산하고, 기출을 반복해 과락과 미학습을 줄입니다.

> 이름 유래: **OneQ**(원큐, 한 번에) + **Ace**(에이스, A학점을 받듯 시험 통과) — "한 번에 에이스가 된다"

## 구성

| 폴더 | 내용 | 상태 |
|---|---|---|
| `app/` | 스마트폰 학습앱 — 정적 PWA (Vite + React + TypeScript) | 0단계: 실기기 저장 검증 화면 |
| `preprocessor/` | PC 기출 PDF 전처리기 `oneq-prep` (Python) | 2단계에서 시작 |
| `docs/` | 세션 기록, 실기기 결과표, 결정 기록(ADR) | |

- 서버·DB·외부 API 없음. 모든 학습 기록은 기기 안에만 저장됩니다.
- 이 저장소에는 **앱 코드만** 있습니다. 기출 PDF·문항 이미지·문제팩은 커밋하지 않습니다(`.gitignore`).

## 개발 시작

```bash
cd app
npm install
npm run dev        # http://localhost:5173/OneQ-Ace/
npm run build      # dist/ 생성
```

`main` 브랜치에 푸시하면 GitHub Actions가 `app/`을 빌드해 GitHub Pages에 배포합니다.
배포 주소: `https://<GitHub사용자명>.github.io/OneQ-Ace/`

## 세션 규칙

모든 개발 세션은 [`docs/SESSION.md`](docs/SESSION.md)로 시작하고 끝냅니다. 개발 기준은 claude.ai 프로젝트의 「원큐합격 개발기준서」입니다.
