# oneq-prep (기출 PDF 전처리기)

기출 PDF를 원큐합격 문제팩(`.zip`, 포맷 `oqp/1`)으로 바꾼다. 포맷은 `shared/pack-schema.json`, 결정 이유는 `docs/ADR/001-pack-format-oqp1.md`.

## 현재 상태 — 1단계 프로토타입 (명령줄)

텍스트층이 있는 2단 레이아웃 PDF(comcbt 교사용 형식)를 처리한다. GUI·검수 화면·OCR·형광 표시 연결은 2단계.

```
pip install -r preprocessor/requirements.txt
cd preprocessor

# 팩 만들기 (여러 PDF를 한 번에 넣으면 같은 해 시행일 순서로 회차를 정함)
python -m oneq_prep.pack ../source_pdf/survey_기출_2011_2022/*.pdf ../packs --prepared-by 이름 --origin "출처"

# 팩 검사 (--deep: 이미지까지 열어 크기·형식 확인)
python -m oneq_prep.validate --deep ../packs/*.zip

# 시험
python -m pytest -q tests
```

| 모듈 | 하는 일 |
|---|---|
| `extract.py` | 단 구분·본문 영역 판정, 문항 경계(번호 연속성 1→100), 과목 머리말, 보기 번호와 정답 표시(❶~❹), 문서 끝 정답표 |
| `render.py` | 288dpi 렌더링, 정답 표시 제거(마스킹)·잔존 검사, 문항 크롭(단·페이지 넘김 이어 붙임), 1080px WebP |
| `pack.py` | 정답 교차 검증(보기 표시 vs 정답표), questions.json·manifest.json·해시, zip |
| `validate.py` | 스키마 + 정합성 검사. 학습앱 `app/src/pack/validate.ts`와 같은 오류 코드 |

## 확정된 기술 선택 (개발기준서 D8~D11)

- Python 3.11 + PySide6, PyInstaller 단일 실행파일(관리자 권한·네트워크 불필요) — 2단계
- PDF: pypdfium2(렌더링) + pdfplumber(문자 좌표)
- 텍스트 분석: kiwipiepy + scikit-learn TF-IDF — 6단계
- OCR(스캔본만): Tesseract(kor) 선택 설치 — 2단계 이후

실제 기출 PDF·팩(zip)은 저장소에 커밋하지 않는다(`.gitignore`).
