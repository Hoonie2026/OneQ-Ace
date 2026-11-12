; 원큐합격 문제팩 생성기(구 전처리기) 설치 프로그램(Inno Setup 6) — PREP-PLAN-v0.5 D1, 🖥P14 후속(사용자 2026-11-11 "B: 설치 프로그램")
; 관리자 권한 없이 사용자 폴더(%LOCALAPPDATA%\Programs\OneQ-PackMaker — 전처리기 시절 설치는 그 폴더를 그대로 씀)에 설치, 시작 메뉴·바탕화면 바로가기, Windows 설정에서 제거.
; 만든 문제팩(문서\원큐합격 문제팩)과 설정(%APPDATA%\OneQ-Ace)은 제거해도 남는다.
; 만들기(preprocessor 폴더에서, PyInstaller로 dist\OneQ-PackMaker를 만든 뒤):
;   ISCC.exe /DMyVersion=0.5.0-dev.2 /DMyNumVersion=0.5.0 packaging\oneq-prep.iss  → dist\OneQ-PackMaker-Setup.exe
; GitHub 빌드(.github/workflows/release-prep.yml)와 PC 빌드(packaging\build_exe.ps1)가 같은 방법으로 부른다.

#ifndef MyVersion
  #define MyVersion "0.0.0-dev"
#endif
#ifndef MyNumVersion
  #define MyNumVersion "0.0.0"
#endif
#define MyAppName "원큐합격 문제팩 생성기"
#define MyExe "OneQ-PackMaker.exe"
; 이름을 바꾸기 전(2026-11-12까지)의 이름 — 업데이트 때 옛 바로가기·실행파일을 지운다
#define OldAppName "원큐합격 전처리기"
#define OldExe "OneQ-Prep.exe"

[Setup]
; AppId는 바꾸지 않는다 — 같은 값이어야 새 판이 기존 설치를 덮어쓴다(업데이트)
AppId={{0C6CE5CD-9D0C-4DEA-8F95-DEC51E66664B}
AppName={#MyAppName}
AppVersion={#MyVersion}
AppVerName={#MyAppName} {#MyVersion}
AppPublisher=원큐합격(OneQ-Ace)
AppPublisherURL=https://hoonie2026.github.io/OneQ-Ace/
AppSupportURL=https://github.com/Hoonie2026/OneQ-Ace/releases
VersionInfoVersion={#MyNumVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} 설치
DefaultDirName={autopf}\OneQ-PackMaker
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=OneQ-PackMaker-Setup
SetupIconFile=oneq-prep.ico
UninstallDisplayIcon={app}\{#MyExe}
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
; 한국어 번역: Inno Setup에 들어 있으면 그것, 없으면 빌드가 받아 둔 packaging\Korean.isl(비공식 번역), 둘 다 없으면 영어
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
  #pragma message "설치 화면 언어: 한국어(Inno Setup 기본)"
Name: "ko"; MessagesFile: "compiler:Languages\Korean.isl"
#elif FileExists(AddBackslash(SourcePath) + "Korean.isl")
  #pragma message "설치 화면 언어: 한국어(packaging\Korean.isl)"
Name: "ko"; MessagesFile: "Korean.isl"
#else
  #pragma message "설치 화면 언어: 영어(한국어 번역 파일 없음)"
Name: "en"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; GroupDescription: "바로가기:"

[Files]
Source: "..\dist\OneQ-PackMaker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; 업데이트 때 옛 판의 _internal 찌꺼기(지워진 라이브러리)가 남지 않게
Type: filesandordirs; Name: "{app}\_internal"
; 이름 변경(전처리기 → 문제팩 생성기, 사용자 2026-11-12): 옛 실행파일·옛 이름 바로가기
Type: files; Name: "{app}\{#OldExe}"
Type: files; Name: "{autoprograms}\{#OldAppName}.lnk"
Type: files; Name: "{autodesktop}\{#OldAppName}.lnk"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyExe}"; WorkingDir: "{app}"; Comment: "기출 PDF를 원큐합격 문제팩으로"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyExe}"; Description: "{#MyAppName} 실행"; Flags: nowait postinstall skipifsilent
