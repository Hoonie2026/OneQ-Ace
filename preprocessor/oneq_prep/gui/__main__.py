import multiprocessing
import sys

if __name__ == "__main__":
    # 실행파일(PyInstaller)에서 여러 회차 동시 처리(ProcessPool)를 쓰려면 맨 먼저 필요
    multiprocessing.freeze_support()
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        if sys.stdout is None:   # 창 프로그램용 exe에는 콘솔이 없다 → 기록 파일로
            log = open("oneq-prep-cli.log", "w", encoding="utf-8")  # noqa: SIM115
            sys.stdout = sys.stderr = log
        # 실행파일로도 명령줄 처리: 원큐합격-전처리기.exe --cli <PDF…> <출력폴더> --cert … (점검·일괄 작업용)
        from oneq_prep.pack import main as cli_main

        cli_main(sys.argv[2:])
    else:
        from oneq_prep.gui.app import main

        main()
