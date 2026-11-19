# PC-TODO — PC가 필요한 일

- PC 일은 이 파일에만 적는다. 끝나면 [x]와 날짜·결과 한 줄
- PC 연결은 파일 읽기·가져오기와 Chrome만 되고 명령 실행은 안 됨 → git·창 프로그램·PowerShell은 사용자가 실행하고 "Pn 끝"으로 알림
- Claude는 GitHub `main`에만 푸시하고 PC 저장소 파일은 직접 고치지 않는다

## 늘 먼저

- [ ] **P0 동기화**(작업 전마다): 저장소 폴더에서 `git fetch` → `git reset --hard origin/main`. 기출 PDF(`source_pdf/`)·문제팩(`packs/`)은 커밋 대상이 아니라 지워지지 않음

## 남은 일

- [ ] **P37 기록 정리 마무리**(2026-11-19 main 기록을 정리된 커밋 2개로 새로 씀 — 릴리스 태그는 클라우드에서 옮길 수 없음). PC 저장소 폴더에서 차례로:
  1. `git fetch origin` → `git reset --hard origin/main`
  2. `git tag -f prep-v0.5.0 565a3a2` → `git tag -f prep-v0.5.1 2a5e9a8`
  3. `git push --force origin prep-v0.5.0 prep-v0.5.1`
  4. 확인: GitHub 웹 Releases의 두 판 'Source code (zip)'가 새 커밋 것인지, 커밋 목록이 정리된 것(맨 처음 커밋이 「원큐합격 학습앱 v1.0.0 · 문제팩 생성기 0.5.0」)인지. 설치 파일(Setup.exe·zip)은 그대로 남음
  5. (선택) 옛 커밋은 주소(SHA)를 아는 사람에게 한동안 보일 수 있음 — 완전히 지우려면 GitHub Support에 'Remove sensitive data(cached views)' 요청
- [ ] **P36 릴리스 설명 고치기**(GitHub 웹, 폰도 됨): Releases → 「원큐합격 문제팩 생성기 0.5.1」 → 연필(Edit) → 설명 첫 줄(소속·행사 이름이 든 줄)과 바로 아래 빈 줄 삭제 → Update release
- [ ] **P31 정식 릴리스 확인**: 처음부터 한 바퀴 — PC Chrome으로 학습앱 설치 → 첫 화면에서 생성기 Setup.exe 받기·설치 → 종목 조회 → 기출 PDF → 문제팩 → [문제팩 공유하기](카카오톡·메일) → 휴대폰 학습앱 등록 → 학습. 막힌 곳·경고 창 캡처
- [ ] **P32 다른 기기**: 아이폰 1대(설치·등록·풀이·백업), 다른 PC 1대(생성기 설치, 한국어 OCR 기능 확인 `Get-WindowsCapability -Online | ? Name -like 'Language.OCR*'`)
- [ ] (선택) PC에서 e2e: `cd app` → `npm ci` → `npx playwright install chromium` → `npm run e2e`

## 끝난 일(요약)

- 큐넷 출제기준 조회·읽기, Windows 내장 OCR 채택(ADR 022), 설치 프로그램·설치 루트(ADR 023), 스캔본 PC OCR 기록으로 클라우드 재현, 생성기 `prep-v0.5.0`·`prep-v0.5.1` 릴리스 게시
