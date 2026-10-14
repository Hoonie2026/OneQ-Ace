# oneq-prep (기출 PDF 전처리기)

2단계에서 개발합니다. 확정된 기술 선택(개발기준서 D8~D11):

- Python 3.11 + PySide6, PyInstaller 단일 실행파일(관리자 권한·네트워크 불필요)
- PDF: pypdfium2(렌더링) + pdfplumber(문자 좌표)
- 텍스트 분석: kiwipiepy + scikit-learn TF-IDF
- OCR(스캔본만): Tesseract(kor) 선택 설치

출력물은 문제팩 `.zip`이며, 포맷은 1단계에서 `docs/pack-schema.json`으로 확정합니다.
