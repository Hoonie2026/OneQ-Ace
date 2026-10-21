# PyInstaller 설정 — Windows 실행파일(폴더형). 빌드: packaging/build_exe.ps1
# 폴더형(onedir)으로 하는 이유(ADR 018): ① 실행할 때마다 임시 폴더에 풀지 않아 빨리 뜨고 백신 오탐이 적다
# ② Qt DLL이 별도 파일로 남아 LGPL(라이브러리 교체 가능) 조건을 지키기 쉽다
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

HERE = Path(SPECPATH).resolve()            # preprocessor/packaging
PRE = HERE.parent                           # preprocessor
REPO = PRE.parent

datas = [
    (str(PRE / "standards" / "*.json"), "standards"),          # 출제기준 프로필 + law-terms.json
    (str(PRE / "oneq_prep" / "gui" / "fonts" / "*"), "oneq_prep/gui/fonts"),   # Pretendard(OFL)
    (str(REPO / "shared" / "pack-schema.json"), "shared"),
    (str(PRE / "THIRD-PARTY-NOTICES.txt"), "."),
]
if list((PRE / "standards").glob("*.csv")):
    datas.append((str(PRE / "standards" / "*.csv"), "standards"))   # 공공데이터 종목 목록(있으면)
icon_png = PRE / "oneq_prep" / "gui" / "icon.png"
if icon_png.exists():
    datas.append((str(icon_png), "oneq_prep/gui"))
datas += collect_data_files("pdfminer")                    # 글꼴 cmap
datas += collect_data_files("jsonschema_specifications")   # 스키마 메타
datas += collect_data_files("pypdfium2_raw") + collect_data_files("pypdfium2")
binaries = collect_dynamic_libs("pypdfium2_raw")

icon_ico = HERE / "oneq-prep.ico"

a = Analysis(
    [str(PRE / "oneq_prep" / "gui" / "__main__.py")],
    pathex=[str(PRE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=["oneq_prep.gui.app", "oneq_prep.pack", "oneq_prep.batch", "oneq_prep.lawtag", "oneq_prep.summary", "oneq_prep.certs"],
    excludes=["tkinter", "matplotlib", "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets", "PySide6.Qt3DCore",
              "PySide6.QtQuick", "PySide6.QtQml", "PySide6.QtMultimedia", "PySide6.QtCharts", "PySide6.QtDataVisualization",
              "pytest", "pytestqt", "scipy", "pandas", "lxml", "IPython", "sympy", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="OneQ-Prep",
    console=False,
    icon=str(icon_ico) if icon_ico.exists() else None,
    version=str(HERE / "version_info.txt") if (HERE / "version_info.txt").exists() else None,
    upx=False,                 # UPX 압축은 백신 오탐을 늘린다 — 쓰지 않음
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="OneQ-Prep")
