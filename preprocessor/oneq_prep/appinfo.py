"""학습앱 주소(ADR 021 7절 "통합 배포 = 주소 하나") — 전처리기 첫 화면 QR이 보여 주는 주소.

앱 쪽 같은 값: app/vite.config.ts BASE·related_applications, app/src/prep.ts(전처리기 받기 주소).
QR은 주소를 보여 줄 뿐, 팩을 보내지 않는다(전처리기 → 앱 직접 보내기는 폐기, 7절).
"""
from __future__ import annotations

APP_URL = "https://hoonie2026.github.io/OneQ-Ace/"


def qr_png(data: str = APP_URL, scale: int = 5) -> bytes | None:
    """주소 QR 그림(PNG). segno가 없으면 None — 창은 주소 글자만 보여 준다."""
    try:
        import io

        import segno
    except ImportError:
        return None
    buf = io.BytesIO()
    segno.make(data, error="m").save(buf, kind="png", scale=scale, border=2, dark="#0f1d2e")
    return buf.getvalue()
