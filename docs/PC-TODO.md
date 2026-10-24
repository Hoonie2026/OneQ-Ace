# PC-TODO — PC가 필요한 일 (유일한 목록)

- 규칙: PC 일은 **이 파일에만** 적는다(SESSION.md·계획 문서는 여기를 가리킴). 끝나면 [x]와 날짜·결과 한 줄, 필요 없어지면 "취소된 것"으로 옮기고 이유. 번호는 다시 쓰지 않음
- 작업 환경(2026-10-24~): PC 연결됨. Claude는 PC 파일 읽기·쓰기와 Chrome(Claude in Chrome)은 되지만 **PC에서 명령 실행은 안 됨** → git·빌드·창 프로그램·PowerShell은 사용자가 실행
- 클라우드 작업 공간은 큐넷에 직접 접속 못 함(프록시 403) → 큐넷 화면 확인·표본 받기는 PC Chrome에서
- **동기화 규칙**: Claude는 GitHub `main`에만 푸시, PC 저장소 파일은 직접 고치지 않음. 사용자는 작업 전마다 P0. PC에서 저장소 파일을 고쳐야 하면 먼저 Claude에게 알림

## 0. 늘 먼저
- [ ] **P0 동기화**(작업 전마다): `cd C:\Users\dohwa\Downloads\OneQ-Ace` → `git fetch` → `git reset --hard origin/main`. 팩(`packs/`)·기출(`source_pdf/`)은 커밋 대상이 아니라 지워지지 않음

## 1. 큐넷 출제기준 (A1·A2의 전제)
- [x] **P2 큐넷 출제기준 자료실 화면** — 2026-10-24 확인:
  - 목록 검색 `schType=T&schText=종목명`(부분 일치 → "토목기사"로 토목기사·철도토목기사 둘 다 → 정확한 이름으로 고름), 제목에 적용 기간
  - 미래 적용 기준도 미리 게시(예: 정보처리기사 2027.1.1~) → 오늘이 든 기간 = 현행
  - 종목코드: 토목기사 1250, 철도토목기사 1760, 측량 1380
  - 현행 게시물 = 보고서 보기 창(`cst006Report(종목코드, 번호)` → Crownix HTML5 Viewer `pageLink.do?link=cst/cstReport`) → [저장] → PDF. 예전 게시물은 HWP 첨부. Claude가 자동 클릭하면 오류 페이지(`error_pop.jsp?c=-213`)
  - 사용자가 받은 토목기사 PDF(13쪽, 글자 PDF, 표 추출 잘 됨) → 저장소 `preprocessor/tests/fixtures/standards/CIVIL-qnet-2026-2027.pdf`. PC의 `preprocessor/tests/fixtures/web/3-…pdf`는 지워도 됨(커밋 안 됨)
- [x] **P17 보기 창 PDF 자동 받기 확인** — 2026-10-24 Claude in Chrome으로 확인: **된다**. 목록 GET `cst006.do?id=cst00601s01&…&schText=종목명&schType=T&brdId=Q006&code=1202`(줄마다 `cst006Report('종목코드','게시번호')`, 칸 title = 정확한 종목명), PDF는 보기 창 [PDF 저장]과 같은 POST `ReportingServer/service`(opcode 500 · HRD_QSC.mrd · jmCd·mcrtrNo·rcgnMthdCd[A] · protocol=file) — 쿠키·로그인 불필요, 받은 파일이 직접 저장한 토목(104,637B)·건설안전(180,372B)과 같은 크기. 공개 API가 아니라 바뀌면 끌어다 놓기로 안내. 구현 `oneq_prep/qnet.py`. 원래 요청: 보기 창이 PDF를 받아 오는 네트워크 요청을 보고 전처리기가 직접 부를 수 있는지. 안 되면 "보기 창에서 [저장]한 PDF를 끌어다 놓기" 안내
- [x] **P18 출제기준 표본 더 받기** — 2026-10-24 받음: 건설안전기사(2026.1.1~2030.12.31, 32쪽)·측량및지형공간정보기사(2025.1.1~2027.12.31) → 저장소 `fixtures/standards/SAFETY-qnet-2026-2030.pdf`·`SURVEY-qnet-2025-2027.pdf`, 파서 보완(쪽 끝에서 잘린 주요항목, 번호 없는 세세항목, 줄 잇기 규칙). PC `fixtures/web/`의 3개는 지워도 됨. 원래 요청:(사용자, A1 시험용): 측량및지형공간정보기사·건설안전기사 현행 출제기준 PDF — 보기 창 [저장] → `preprocessor/tests/fixtures/web/`에 두면 Claude가 저장소로 옮김. A1 파서는 토목기사 1개로만 맞춰 놓음(2026-10-24) → 표가 다르게 생긴 종목에서 깨지는지 이 표본으로 확인. 측량 1과목 단원 실측(C2·P8)에도 측량 출제기준이 필요

- [ ] **P19 큐넷 자동 받기 PC 실측**(A2·A3 코드 뒤, 사용자): ① P0 → `cd preprocessor` → `py -3 -m oneq_prep.qnet 측량및지형공간정보기사 --list` (목록이 나오면 됨) ② `py -3 -m oneq_prep.qnet 토목기사` (받음·프로필 경로 출력) ③ 창 프로그램에서 종목 고르기 → "큐넷 확인/받았어요" 안내가 뜨는지. 클라우드는 큐넷 접속이 막혀 실제 요청은 PC에서만 확인 가능. 받은 PDF·프로필은 사용자 폴더(`%APPDATA%\OneQ-Ace\qnet`, `…\standards`)

- [ ] **P20 comcbt 첫 쪽 받기 PC 실측**(사용자): ① P0 → `cd preprocessor` → `py -3 -m oneq_prep.comcbt 토목기사 C:\Temp\comcbt --list` (최근 회차 목록이 나오면 됨) ② `py -3 -m oneq_prep.comcbt 토목기사 C:\Temp\comcbt` (교사용 PDF가 받아지는지 — 받기 주소가 다른 곳으로 넘겨줘 클라우드·브라우저 시험으로는 확인 못 함) ③ 창 프로그램 [comcbt 최근 기출 받기]

## 2. OCR 엔진 고르기 (→ 문항 글자 확보 → 모든 분류의 전제)
- [x] **P3 Windows 내장 OCR 한국어** — 2026-10-24: 사용자 PC `Language.OCR~~~ko-KR` Installed. 사내 기본 상태인지는 동료 PC 한 대에서 같은 명령(`Get-WindowsCapability -Online | ? Name -like 'Language.OCR*'`)으로 한 번 더(P14 때 함께)
- [ ] **P4 스캔본 표본 확보**: 실제 스캔본 기출 1~2회차(없으면 comcbt PDF를 인쇄해 스캔) → `source_pdf/`에 두고 알림
- [ ] **P5 OCR 3종 비교**: Tesseract / Windows 내장(winocr — PC에서만 돎) / PaddleOCR PP-OCRv5 한국어 — 글자 정확도·정답 표시 인식·처리 시간·설치 부담. 명령은 Claude가 준비, 실행은 사용자
- 의존: P3·P4 → P5 → 엔진 결정(ADR) → 스캔본 분류 실측

## 3. 분류 정확도 실측 (→ 단원별·유형별 화면을 내놓을지 결정)
- [x] **P7 토목기사 기출 PDF** — 2026-10-24 사용자 저장: `source_pdf/civil_기출_2012_2022/` 32개(comcbt 교사용, 2012-03-04 ~ 2022-04-24). 쓰임: **계산 분류는 응용역학 과목 기준으로 검증**(사용자 지정, C2)
- [ ] **P8 측량 1과목 단원(세부항목) 배정 실측, 건설안전 1과목 법령 판정 실측**(C2) — 측량은 2026-10-24 끝(Claude가 PC 연결로 읽음, ADR 021 4.6), 건설안전 법령 남음 — PDF는 이미 `source_pdf/`에 있음, Claude가 PC에서 읽어 옴
- 정답표(사람 분류)는 Claude가 만들고 자동 판정과 비교. 글자 PDF(comcbt 교사용)라 P5 전에도 가능

## 4. 배포·실기기
- [ ] **P9 실행파일 빌드 실측**: `packaging\build_exe.ps1`(백신 오탐·동료 PC 실행)
- [ ] **P14 서명 안 된 exe 경고 확인**: 사내 PC에서 전처리기 zip 받아 실행 시 "Windows의 PC 보호"·백신 반응 캡처(P9와 함께) + (사용자) 사내 IT 배포 시스템으로 올릴 수 있는지 문의 → PREP-PLAN-v0.5 D1
- [ ] **P16 묶음 가져오기 실측**(B4 코드 뒤): 측량 31회차·건설안전 59회차 묶음 크기, 폰(Android)·PC에서 묶음 1개 vs 회차별 여러 개 가져오기 시간·멈춤 여부, 기존 팩 있는 종목에 회차 몇 개 추가(건너뜀·기록 유지 확인) — ADR 021 8절
- [ ] **P10 전처리기 v0.4.0 창 써 보기**: 화면 불편 메모(우선순위 낮음 — 흐름이 v0.5에서 크게 바뀜. 디자인은 사용자 만족, 유지)
- [ ] **P11 앱 실기기**: v0.11.4 Q9, v0.10.8 P6~P8, 2011 측량 3회차 재배정 검수(`docs/device-tests.md`)
- [ ] **P12 e2e PC에서 다시**(v0.10.7 이후 PC 실행 안 함)

## 취소된 것 (다시 하지 않음)
- ~~P1 comcbt 실제 화면~~(2026-10-24 확인은 마침 — 결과는 ADR 021 1절 "참고로 남김") · ~~P6 수집 시험~~ — **기출 웹 수집 전면 폐기**(ADR 021 1절, 2026-10-24)
- ~~큐넷 OpenAPI 응답 `km-1380.xml`·`qual-list.xml` 받기·공공데이터포털 활용신청~~ — API·계정 배제(ADR 021 1절)
- ~~공공데이터 종목 CSV 내려받아 넣기~~(ADR 019) — 큐넷 출제기준 자료실 검색으로 대체
- ~~HWP·DOC 기출 → PDF 자동 변환(LibreOffice+Java)~~ — 사용자 기각, 안내만
- ~~comcbt 관리자에게 사전 문의~~ — 사용자 판단(2026-10-22). 기출 수집 폐기로 더 필요 없음
- ~~P13 PC→폰 직접 전송 실측~~ · ~~P15 카카오톡 전송 실측~~ — 전처리기에서 학습앱으로 직접 보내기 폐기(ADR 021 7절, 2026-10-23)
