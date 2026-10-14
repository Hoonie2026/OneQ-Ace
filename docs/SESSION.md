# SESSION.md

모든 세션은 이 파일로 시작하고 이 파일로 끝낸다(개발기준서 9.1).

## 현재 위치

- **단계**: 1단계 — 팩 포맷 (완료, 게이트 통과)
- **게이트**: 샘플팩이 Python·TS 검증기 모두 통과 → ✅
- **0단계**: Android 게이트 조건부 통과(2026-10-14). T8a(공유 시트)만 ⚠️ — 백업 기본 경로는 다운로드로 확정, 공유는 보조(3단계에서 재확인). iPhone 보조 확인은 미실시

## 직전 세션 요약 — 2026-10-14 (세션 #2, 1단계)

### 완료
- 기출 PDF 34회차(측량및지형공간정보기사 2011~2022.03, comcbt 교사용) 분석
  - 전부 텍스트층 있는 2단 레이아웃, 5과목 × 20문항, 정답은 보기의 채운 원문자(❶~❹) + 마지막 페이지 정답표
  - 3,400문항 전부: 문항 경계 100/100, 보기 표시 정답 1개, **정답표와 100% 일치**
- `shared/pack-schema.json`(oqp/1) 확정 — 결정 기록 `docs/ADR/001-pack-format-oqp1.md`
  - 추가 필드: `answerMasking`(정답 표시 제거 기록, leakCheck 필수), `answerSource`·`answerCheck`, `imgSize`, `exam.date`·`roundLabel`
- 전처리 프로토타입 `preprocessor/oneq_prep/`(extract·render·pack·validate) — 2단계의 출발점
  - 정답 표시 제거: 채운 원문자 자리를 지우고 같은 페이지의 일반 원문자 픽셀을 옮겨 붙임 → 흔적 없음. 잔존 검사(잉크 비율) 0건
  - 지문 속 원문자("❶~❹의 각")는 보기 번호와 구분해 유지
  - 크롭 하단 여백 7pt: 다음 문항의 윗줄표(AB̅)가 앞 문항 끝에 끼던 문제 수정(2012-2회 81번에서 발견)
  - 형광 표시 제거 함수 `remove_highlight()`는 단위시험만(실제 PDF 없음)
- 검증기 2종: `preprocessor/oneq_prep/validate.py`, `app/src/pack/validate.ts`(+ `miniSchema.ts`, CSP 때문에 ajv 대신 자체 해석기)
  - 공용 시험 `shared/fixtures/cases.json` 22건 + 더미 팩 `valid-pack/` → pytest 24건, vitest 25건 통과
- 샘플팩 실측: 회차당 2.5~2.9MB(100문항, WebP 1080px q80). 전 34회차 팩 생성·심층 검증 통과
- 앱: `npm test`(vitest 5) 추가, 테스트 파일은 `tsconfig` 타입검사에서 제외

### 결정·변경
- ADR 001: qid = `packId-번호3자리`, 스키마 위치 `shared/`, answerMasking 필수, TS는 miniSchema
- `.gitattributes` 추가: `shared/fixtures/**` 줄바꿈 변환 금지(해시 검사 보호)

### 미완
- iPhone 보조 확인(동료 기기, 7단계 전 필수)
- T8a 공유 시트: `files`만 넘기도록 수정함 → 3단계 실기기 점검 때 재확인
- 사내 게시판 첨부 용량 제한 확인(팩 2.5~2.9MB/회차 기준으로 분할 단위 결정)
- 2단계 게이트용 "출처가 다른 PDF 3종": ① comcbt 교사용(채운 원문자+정답표) ② 한솔아카데미 경향문제(노란 형광 상자, 정답표 없음) 확보. ③ 정답표만 있는 PDF(또는 스캔본) 1종 더 필요

## 다음 할 일
1. 3단계(학습앱 코어) 시작 권장 — 백업 내보내기는 다운로드를 기본 버튼, 공유 시트는 보조 버튼으로
2. 2단계(전처리기 MVP) 또는 3단계(학습앱 코어) 시작 — 팩 포맷이 고정됐으므로 어느 쪽이든 가능
   - 3단계를 먼저 하면 실제 샘플팩(`packs/oneq-SURVEY-2022-1.zip`)으로 바로 풀이 화면을 만들 수 있음
   - 2단계 전 필요: 출처가 다른 기출 PDF 2종 이상(형광 표시본, 정답표만 있는 본)
