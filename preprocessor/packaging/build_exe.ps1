# 원큐합격 전처리기 — Windows 실행파일(폴더형) 만들기 (ADR 018)
# 사용(preprocessor 폴더에서):  powershell -ExecutionPolicy Bypass -File packaging\build_exe.ps1
# 결과: dist\OneQ-Prep\OneQ-Prep.exe  +  dist\OneQ-Prep-<버전>-win64.zip (동료에게 나눠 줄 파일)
$ErrorActionPreference = "Stop"
$pre = Split-Path $PSScriptRoot -Parent
Set-Location $pre
$venv = Join-Path $pre ".venv-build"
$py = Join-Path $venv "Scripts\python.exe"

Write-Host "1/5 빌드용 가상환경(.venv-build) 준비" -ForegroundColor Cyan
if (-not (Test-Path $py)) { py -3 -m venv $venv }
& $py -m pip install --upgrade pip --quiet
& $py -m pip install -r requirements-build.txt --quiet
if ($LASTEXITCODE -ne 0) { throw "패키지 설치 실패 — 회사망이면 --trusted-host pypi.org --trusted-host files.pythonhosted.org 를 붙여 보세요" }

Write-Host "2/5 시험(pytest — 창 프로그램 포함)" -ForegroundColor Cyan
$env:QT_QPA_PLATFORM = "offscreen"
& $py -m pytest -q tests
if ($LASTEXITCODE -ne 0) { throw "시험 실패 — 실행파일을 만들지 않습니다" }
Remove-Item Env:QT_QPA_PLATFORM

Write-Host "3/5 실행파일 만들기(PyInstaller, 폴더형)" -ForegroundColor Cyan
& $py -m PyInstaller --noconfirm --clean --distpath dist --workpath build packaging\oneq-prep.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 실패" }
$exe = Join-Path $pre "dist\OneQ-Prep\OneQ-Prep.exe"

Write-Host "4/5 점검: 실행파일로 기출 PDF 2개 처리(--cli)" -ForegroundColor Cyan
$pdfs = @(Get-ChildItem (Join-Path $pre "..\source_pdf\safety_기출_2003_2022\*.pdf") -ErrorAction SilentlyContinue | Select-Object -Last 2)
if ($pdfs.Count -eq 2) {
    $smoke = Join-Path $env:TEMP "oneq-prep-smoke"
    Remove-Item $smoke -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $smoke | Out-Null
    $cliArgs = @("--cli") + ($pdfs | ForEach-Object { '"' + $_.FullName + '"' }) + @("`"$smoke\out`"", "--cert", "SAFETY", "--prepared-by", "smoke", "--workers", "2")
    $p = Start-Process -FilePath $exe -ArgumentList $cliArgs -WorkingDirectory $smoke -Wait -PassThru
    Get-Content (Join-Path $smoke "oneq-prep-cli.log") -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0) { throw "점검 실패(종료 코드 $($p.ExitCode))" }
    $n = (Get-ChildItem "$smoke\out\*.zip").Count
    Write-Host "  점검 통과: 팩 $n개" -ForegroundColor Green
} else {
    Write-Host "  건너뜀: source_pdf\safety_기출_2003_2022 에 PDF가 없음" -ForegroundColor Yellow
}

Write-Host "5/5 나눠 줄 zip 만들기 + Windows Defender 검사" -ForegroundColor Cyan
$ver = & $py -c "import oneq_prep; print(oneq_prep.__version__)"
$zip = Join-Path $pre "dist\OneQ-Prep-$ver-win64.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $pre "dist\OneQ-Prep") -DestinationPath $zip
$mp = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
if (Test-Path $mp) {
    & $mp -Scan -ScanType 3 -File (Join-Path $pre "dist\OneQ-Prep") -DisableRemediation | Select-Object -Last 3
} else {
    Write-Host "  Defender 명령줄을 찾지 못함 — 회사 백신으로 dist\OneQ-Prep 폴더를 직접 검사해 보세요" -ForegroundColor Yellow
}
$size = "{0:N0}MB" -f ((Get-Item $zip).Length / 1MB)
Write-Host "`n완료: $exe`n나눠 줄 파일: $zip ($size)" -ForegroundColor Green
