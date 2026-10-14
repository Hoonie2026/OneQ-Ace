# SESSION.md

모든 세션은 이 파일로 시작하고 이 파일로 끝낸다(개발기준서 9.1).

## 현재 위치

- **단계**: 0단계 — 실기기 저장 검증 (진행 중: 실기기 테스트 대기)
- **게이트**: Android 본인 기기에서 T1~T9 통과. iPhone은 동료 기기로 보조 확인

## 직전 세션 요약 — 2026-10-14 (세션 #1)

### 완료
- 모노레포 골격: `app/`, `preprocessor/`, `docs/`, `.gitignore`(PDF·zip·packs 제외)
- `app/`: Vite 8 + React 18 + TypeScript + vite-plugin-pwa(prompt 업데이트) + Dexie 4 + fflate
- 0단계 검증 화면(T1~T9): 설치 감지, 오프라인 실행, persist/estimate, 30MB 더미 팩(100장 × 300KB) 저장·전수 해시 검증, 재실행 유지 자동 확인, 샘플 zip 생성·가져오기·이미지 미리보기, 백업 내보내기(공유 시트/다운로드), 백업 파일 읽기, 결과 복사·공유
- 저장 실패 전역 경고(`safeWrite` 래퍼), CSP `connect-src 'self'`
- GitHub Actions → GitHub Pages 배포 워크플로
- 클라우드 개발 환경의 모바일 에뮬레이션(Pixel 7, Chromium)으로 T2~T9 동작 확인. 실기기는 아직

### 미완
- GitHub 저장소 생성·푸시·Pages 활성화 (사용자)
- Android 실기기 테스트 → `docs/device-tests.md` 기록
- iPhone 보조 확인(동료 기기)

### 결정·변경
- 결정 변경 없음. 버전만 구체화: Vite 8, TypeScript 7, React 18(D2 유지)
- 0단계 DB 이름은 `oneq-stage0`으로 분리. 3단계에서 본 스키마(`oneq`)로 새로 만든다

## 다음 할 일
1. 실기기 결과를 대화창에 붙여 넣기 → `device-tests.md` 기록, 게이트 판정
2. 실패 항목이 있으면 원인 분석·수정 (필요 시 D1 재검토)
3. 게이트 통과 시 1단계(팩 포맷: `docs/pack-schema.json`, 샘플팩, 검증기) 시작
   - 1단계 전 결정 필요: 사내 게시판 첨부 용량 제한, 휴대폰 첨부 다운로드 가능 여부
