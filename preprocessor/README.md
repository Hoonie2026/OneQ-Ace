# 원큐합격 문제팩 생성기 (`oneq_prep`)

기출 PDF를 원큐합격 학습앱의 **문제팩**(`.zip`, 포맷 `oqp/1`)으로 바꾸는 Windows PC 프로그램입니다.
화면·설치 파일 이름은 **원큐합격 문제팩 생성기**(`OneQ-PackMaker.exe`, `OneQ-PackMaker-Setup.exe`)이고, 파이썬 패키지 이름 `oneq_prep`와 팩의 `generator: "oneq-prep x.y"`는 팩 형식과 이어져 있어 그대로 둡니다(ADR 023).

사용 안내는 [`docs/PREP-GUIDE.md`](../docs/PREP-GUIDE.md), 포맷은 [`shared/pack-schema.json`](../shared/pack-schema.json), 결정 이유는 [`docs/ADR`](../docs/ADR).

## 하는 일

1. **출제기준**: 큐넷 출제기준 자료실에서 종목의 현행 출제기준 PDF를 받아 과목·문항 수·주요항목을 읽습니다(`qnet.py`, `qnet_standard.py`).
2. **기출 읽기**: 텍스트 PDF는 문자 좌표로, 스캔 PDF는 Windows 내장 한국어 OCR로 문항 경계·과목·보기 번호·정답 표시를 찾습니다(`extract.py`, `ocr.py`).
3. **정답 표시 지우기·문항 그림**: 정답 표시(채운 번호·형광펜·펜 ✓/○)를 지우고 보기 번호를 다시 그린 뒤 문항마다 1080px WebP로 자릅니다(`render.py`).
4. **정답 교차 확인**: 여러 회차에 나온 같은 문항끼리 정답을 맞춰 봅니다(`crosscheck.py`). 정답을 못 찾았거나 그림에 정답이 남은 문항도 문제팩에 넣고 표시만 합니다 — 학습자가 학습앱에서 정답을 지정합니다(ADR 024·028).
5. **문제팩**: 종목 하나 = zip 하나(회차별 팩은 안쪽 `.회차별` 폴더), 학습앱 검증기와 같은 규칙으로 검사(`pack.py`, `bundle.py`, `validate.py`).

모든 처리는 PC 안에서 합니다. 큐넷 출제기준을 받을 때 말고는 인터넷을 쓰지 않습니다.

## 지원 형식

| 형식 | 정답 출처 | 정답 표시 지우기 |
|---|---|---|
| 정답이 표시된 텍스트 PDF(채운 원문자 + 끝 정답표) | 보기 표시 ↔ 정답표 교차 | 원문자를 일반 번호로 바꿔 그림 |
| 형광펜 표시형 | 형광 표시 | PDF 객체에서 형광 사각형 삭제 |
| 스캔 PDF(텍스트층 없음) | 끝 쪽 정답표 · 칠한 번호 · 색 펜 ✓/○ | 표시를 지우고 보기 번호 네 개를 같은 모양으로 다시 그림 |

2단 배치, 단·쪽을 넘어가는 문항, 시험지 중간의 과목 상자, 시행 연도마다 다른 과목 구성(옛 과목은 현행 과목으로 합치거나 뺌, ADR 016·027)을 처리합니다.

## 개발

```
pip install -r requirements-gui.txt      # 창 프로그램(PySide6)까지
python -m oneq_prep.gui                  # 창 프로그램
python -m pytest -q tests                # 시험(실제 기출 PDF가 있으면 통합 시험도)
```

명령줄(창 없이):

```
python -m oneq_prep <기출.pdf …> <출력폴더> --cert <종목코드>
python -m oneq_prep.validate --deep <문제팩.zip …>      # 팩 검사
python -m oneq_prep.ocr --check                         # Windows 한국어 OCR 기능 확인
```

Windows 실행파일·설치 프로그램은 GitHub Actions(`.github/workflows/release-prep.yml`)가 `prep-v*` 태그 릴리스에서 만듭니다. PC에서 직접 만들려면 `powershell -ExecutionPolicy Bypass -File packaging\build_exe.ps1`.

## 모듈

| 모듈 | 하는 일 |
|---|---|
| `gui/` | PySide6 창 프로그램 — ① 종목 선택 ② 기출 PDF 올리기 ③ 문제팩 만들기 ④ 문제팩 공유하기 |
| `qnet.py` · `qnet_standard.py` | 큐넷 출제기준 PDF 받기·읽기 → 출제기준 프로필 |
| `standards.py` · `certs.py` | 출제기준 프로필(`standards/<코드>.json`, 사용자 폴더) · 종목 검색(공공데이터 CSV) |
| `examinfo.py` | 문서 내용에서 종목·시행일·회차·출처 읽기 |
| `extract.py` · `ocr.py` · `render.py` | 문항 나누기 · 스캔 PDF OCR · 정답 표시 지우기와 문항 그림 |
| `crosscheck.py` · `reassign.py` | 같은 문항 정답 교차 확인 · 옛 기준 회차의 과목 다시 배정 |
| `pack.py` · `batch.py` · `bundle.py` · `validate.py` | 회차별 팩 · 여러 회차 동시 처리 · 종목 묶음 · 검증 |
| `lawtag.py` · `summary.py` | 법령·기준 문항 표시 · 과목 개편/법령 요약 글 |
| `ocrbench.py` | OCR 실측 도구(개발용) |

`standards/`의 `SURVEY`·`SAFETY`·`CIVIL` 프로필은 시험과 빌드 점검에 쓰는 예시입니다. 실제 사용 때는 창 프로그램이 큐넷에서 받은 출제기준을 사용자 폴더에 저장해 씁니다.

## 기술

Python 3.12 · pypdfium2(렌더링) + pdfplumber(문자 좌표) · Pillow·NumPy · Windows 내장 OCR(`winocr`, ADR 022) · PySide6 + PyInstaller 폴더형 실행파일(ADR 018) · Pretendard 글꼴(OFL).

기출 PDF·문제팩·문항 그림은 저장소에 넣지 않습니다(`.gitignore`).
