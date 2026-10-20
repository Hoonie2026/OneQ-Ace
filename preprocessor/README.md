# oneq-prep (기출 PDF 전처리기)

기출 PDF를 원큐합격 문제팩(`.zip`, 포맷 `oqp/1`)으로 바꾼다. 포맷은 `shared/pack-schema.json`, 결정 이유는
`docs/ADR/001-pack-format-oqp1.md`, `005-subject-standard-in-preprocessor.md`, `012-preprocessor-mvp.md`, `016-safety-2026-merged-subjects.md`.

## 창 프로그램 v0.3.0 (ADR 018) — 동료에게 나눠 주는 방식

```
pip install -r preprocessor/requirements-gui.txt
cd preprocessor
python -m oneq_prep.gui                                   # 창 프로그램
powershell -ExecutionPolicy Bypass -File packaging\build_exe.ps1   # Windows 실행파일(dist\OneQ-Prep\OneQ-Prep.exe + zip)
```

- 사용 안내(동료용): `docs/PREP-GUIDE.md`. 실행파일로도 명령줄 처리: `OneQ-Prep.exe --cli <PDF…> <출력폴더> --cert …`(기록은 `oneq-prep-cli.log`)
- 처리 규칙은 `batch.py`(일괄·동시 처리)·`review.py`(검수 파일)에 있고 명령줄과 창이 함께 쓴다. 화면은 `oneq_prep/gui/`.

## 명령줄 (2단계 MVP + v0.3.0 동시 처리 `--workers`)

```
pip install -r preprocessor/requirements.txt
cd preprocessor

# 팩 만들기 + 검수 보고서 (여러 PDF를 한 번에 넣으면 같은 해 시행일 순서로 회차를 정함)
python -m oneq_prep ../source_pdf/survey_기출_2011_2022/*.pdf ../packs --cert SURVEY --prepared-by 이름 --origin "출처"

# 건설안전기사 59회차(옛 6과목 → 2026 기준 5과목으로 합침, ADR 016)
python -m oneq_prep ../source_pdf/safety_기출_2003_2022/*.pdf ../packs --cert SAFETY --prepared-by 이름 --origin "comcbt.com"

# 시행일이 파일명에 없는 PDF(예: 토목기사_2024_3회_경향문제.pdf)
python -m oneq_prep ../source_pdf/civil_경향문제/*.pdf ../packs --cert CIVIL --prepared-by 이름 --source-type other --date 2024-07-05

# 팩 검사 (--deep: 이미지까지 열어 크기·형식 확인)
python -m oneq_prep.validate --deep ../packs/*.zip

# 시험 (source_pdf가 있으면 실제 PDF 통합 시험도 돈다)
python -m pytest -q tests
```

Windows PowerShell은 `*.pdf`를 풀어 주지 않으므로 `(Get-ChildItem ..\source_pdf\survey_기출_2011_2022\*.pdf).FullName`을 넘기거나 PDF를 하나씩 적는다.

### 검수 흐름

1. 명령을 실행하면 `출력폴더/review/report.html`(회차별 요약)이 생긴다. 막히는 문제가 없는 회차는 팩 zip이 바로 만들어진다.
2. 회차 이름을 눌러 문항 카드를 본다(**경고**·**재배정 제안**·**그림 포함** 단추로 걸러 보기).
3. 정답·과목·제외를 고치고 **검수 파일 저장** → 받은 `팩ID.review.json`을 `review/` 폴더에 넣는다(덮어쓰기).
4. 같은 명령을 다시 실행하면 반영된다. 구기준 회차(측량 2011)는 **검수 완료**를 체크해야 재배정이 들어간다.

`review/`에는 문항 이미지가 들어 있으므로 저장소에 커밋하지 않는다(`packs/` 아래에 두면 `.gitignore`로 빠짐).

## 지원 형식

| 형식 | 정답 출처 | 정답 표시 제거 | 상태 |
|---|---|---|---|
| comcbt 교사용(채운 원문자 ❶~❹ + 문서 끝 정답표) | 보기 표시 ↔ 정답표 교차 검증 | 같은 페이지 일반 원문자 픽셀로 교체 | 측량 34회차 · 건설안전 59회차 검증 |
| 형광펜 표시형(노란 사각형, 과목마다 번호 1부터) | 형광 표시 | PDF 객체 단계에서 노란 사각형 삭제 | 토목 2024-3 경향문제 검증 |
| 스캔본(텍스트층 없음) | 진하게 칠한 보기 번호 또는 검수 파일 | 지우고 글꼴로 원문자 다시 그림 | **시험용 모의 스캔만** — 실제 스캔본으로 보정 필요 |

스캔본은 Tesseract가 필요하다(선택 설치): <https://github.com/UB-Mannheim/tesseract/wiki> 설치 때 **Korean** 선택.
PATH에 없으면 환경변수 `ONEQ_TESSERACT=C:\Program Files\Tesseract-OCR\tesseract.exe`.

## 출제기준 프로필 `standards/<종목코드>.json`

```json
{ "code": "CIVIL", "name": "토목기사", "grade": "기사", "version": "2022",
  "passRule": { "subjectMin": 40, "avgMin": 60 },
  "subjects": [ { "name": "응용역학", "count": 20 }, ... ],      // 현행 과목(순서 = 팩 과목 번호)
  "aliases":  { "옛 과목명": "표준 과목명" },
  "excluded": [ "건설재료" ],                                     // 현행에 없는 과목 → 팩에서 뺌(manifest.excluded)
                                                                  // 옛 두 과목을 같은 표준 이름에 별칭으로 걸면 한 과목으로 합쳐짐 →
                                                                  // 팩 과목에 examCount(실제 시험 문항 수)가 붙음(ADR 016)
  "legacy":   { "before": "2012-01-01", "action": "reassign" }   // 이 날짜 전 회차는 문항별 과목 재배정
}
```

| 프로필 | 상태 |
|---|---|
| `SURVEY` 측량및지형공간정보기사 | 확정(2012~ 5과목, 2011은 재배정) |
| `CIVIL` 토목기사 | 6과목(한솔 경향문제 제목줄 기준) — 큐넷 출제기준 표기와 다르면 aliases로 |
| `SAFETY` 건설안전기사 | 확정(2026 기준 5과목 100문항). 2025년까지의 6과목 기출은 산업안전관리론·산업심리 및 교육을 한 과목(회차당 40문항, examCount 20)으로 합침 |
| `RAILCIVIL` 철도토목기사 | **초안**(`draft`) — 현행 과목명·문항 수 확인 후 채우기 |

## 모듈

| 모듈 | 하는 일 |
|---|---|
| `extract.py` | 단 구분·페이지별 본문 영역, 문항 경계(연속 번호 / 과목마다 1부터, 마지막 문항 뒤 안내문 끊기), 과목 머리말·제목줄, 보기 번호(어긋나면 배치 모양으로 다시 고름), 정답 표시(채운 원문자·형광), 정답표, 되풀이 안내문 제거 |
| `ocr.py` | 스캔본 판정, Tesseract로 글자 좌표 생성(보기 번호 자리표) |
| `render.py` | 288dpi 렌더링, 정답 표시 제거(원문자 교체·형광 삭제·스캔 칠한 번호)·잔존 검사, 문항 크롭, 1080px WebP |
| `standards.py` | 출제기준 프로필 읽기, 과목명 정규화·별칭·제외 판정 |
| `reassign.py` | 구기준 회차 과목 재배정 제안(글자 2-gram 유사도 투표) |
| `pack.py` | 준비(검사) → 검수 파일 반영 → 팩 쓰기, 명령줄 |
| `batch.py` | 여러 PDF 일괄 처리 — 회차별 독립, CPU 코어 나눠 동시 처리(spawn), 진행 이벤트·멈추기 |
| `review.py` | 검수 파일 만들기 규칙(HTML 보고서와 같은 결과) |
| `gui/` | PySide6 창 프로그램(목록·진행·검수 창) |
| `report.py` | 검수 보고서 HTML |
| `validate.py` | 스키마 + 정합성 검사. 학습앱 `app/src/pack/validate.ts`와 같은 오류 코드 |

## 확정된 기술 선택 (개발기준서 D8~D11)

- Python 3.11, PDF: pypdfium2(렌더링·형광 객체 삭제) + pdfplumber(문자 좌표)
- PySide6(Essentials) 창 프로그램 + PyInstaller **폴더형** 실행파일(ADR 018 — 단일 파일 대신: 기동 속도·백신 오탐·Qt LGPL)
- 텍스트 분석: kiwipiepy + scikit-learn TF-IDF — 6단계
- OCR(스캔본만): Tesseract(kor) 선택 설치

실제 기출 PDF·팩(zip)·검수 보고서는 저장소에 커밋하지 않는다(`.gitignore`).
