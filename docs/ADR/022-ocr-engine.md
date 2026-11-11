# ADR 022 — 스캔본 OCR 엔진: Windows 내장 OCR(PREP-PLAN-v0.5 B1)

- 상태: 결정(사용자 2026-11-11 16:59 "동료 PC에도 내장되어 있는 것만으로")
- 근거 자료: 🖥P5 비교(`oneq_prep/ocrbench.py`, 정답 `tests/fixtures/ocr/railway-2010-2-gt.json`), 표본 `source_pdf/철도보선기사_스캔본.pdf`(2010년 2회, 10쪽, 실제 종이 스캔 ≈120dpi)

## 비교 결과(사용자 PC, Windows 11, CPU, 파이썬 3.11)

| 엔진 | 본문 글자 맞춤(×2) | 95%↑ 단위 | 정답표 100개(칸 나눠 읽기) | 쪽당 |
|---|---|---|---|---|
| **Windows 내장(winocr, ko)** | **92.9%** | 59.2% | **100/100** | **1.1초** |
| Tesseract 5(kor) | 89.8% | 44.9% | 100/100 | 3.1초 |
| PaddleOCR 3.7(PP-OCRv5 한국어) | 23.8% | 0% | 0/100 | 약 130초 |

- PaddleOCR: PaddlePaddle 3.3은 oneDNN과 충돌(`ConvertPirAttribute2RuntimeAttribute`), 3.2.2 + `enable_mkldnn=False`에서도 무거운 글자 찾기 모델(server_det)은 추론 중 C++ access violation, 가벼운 모델은 돌지만 한글을 한자·가나로 읽고 쪽당 2분 이상. 크기(+600MB)·실행파일 묶기·동료 PC 충돌 위험까지 → **제외**. 외부 분석(제미나이)의 `enable_mkldnn=False` 처방은 이미 적용된 상태였고 제시 코드는 PaddleOCR 2.x 문법이라 3.7에 맞지 않음
- 정답표는 쪽 통째로 읽으면 세 엔진 모두 낱자를 건너뜀(5~9/100) → **표 격자를 칸으로 자르고, 답 줄마다 칸을 이어 붙인 한 줄 그림으로 읽기**(Tesseract는 psm 7, 가나다라 밖 비슷한 글자 보정, 번호 줄은 건너뜀) → 두 엔진 모두 100/100

## 결정
1. 스캔본 OCR = **Windows 내장 OCR만**(배포 설치 프로그램에 다른 엔진 넣지 않음). 한국어 Windows는 한국어 OCR 기능이 보통 미리 설치됨(사용자 PC 🖥P3 확인). 없으면 Windows 11은 일반 사용자도 [설정 → 시간 및 언어 → 언어 및 지역 → 한국어 → 언어 옵션]에서 추가 가능(회사 정책으로 막혔으면 IT) — 전처리기가 스캔본을 만났는데 기능이 없으면 이 경로를 안내
2. OCR은 스캔본에만 필요 — 글자 PDF(comcbt 교사용 등)는 OCR 없이 처리
3. 기존 Tesseract 경로(`ocr.py`)는 지우지 않고, 직접 설치된 PC에서만 예비로 자동 사용
4. 끝 쪽 정답표는 칸 나눠 읽기(ocrbench의 `table_rows`·`_strip`·`_letters`를 본 경로로 옮김). **손글씨 ✓ 표시는 정답으로 쓰지 않음**(표본 1번·9번 모두 시험 본 사람의 오답 표시)
5. 보기 번호 **가나다라**도 읽음(지금 파서는 ①~④ 전제)
6. 글자 맞춤 92.9%는 완벽하지 않음("시엔트" 등) → 스캔본 문항은 지금 설계대로 `ocr`·`needs-review` 표시, 의심 문항만 검수
7. 🖥P14 때 동료 PC 한 대에서 한국어 OCR 기능 기본 설치 여부 확인(`Get-WindowsCapability -Online | ? Name -like 'Language.OCR*'`)
