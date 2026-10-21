import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { backupDue } from './backup';
import { describeError, STORAGE_ERROR_EVENT } from './db';
import { describeIssues, importPackFile } from './pack/import';
import { examLabel, type Target } from './study';
import { formatBytes, resetPageZoom } from './util';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Home } from './ui/Home';
import { PackDetail } from './ui/PackDetail';
import { PlanSetup } from './ui/PlanSetup';
import { DaySummary } from './ui/DaySummary';
import { Result } from './ui/Result';
import { Settings } from './ui/Settings';
import { Solve } from './ui/Solve';
import { askConfirm, DialogHost, showNotice } from './ui/Dialog';
import { ImportProgressView } from './ui/ImportProgressView';
import { clearPick, INTERRUPTED_MESSAGE, interruptedPick, markPickStart, PICK_FAILED_MESSAGE, SLOW_PICK_MS, SLOW_PICK_TIP, summarizeImported, type ImportedSummary, type ImportProgress } from './importFlow';
import { unbundle } from './pack/bundle';

type Screen =
  | { name: 'home' }
  | { name: 'solve'; target: Target }
  | { name: 'result'; target: Target; back?: 'solve' }
  | { name: 'pack'; packId: string }
  | { name: 'plan'; certCode: string; certName: string }
  | { name: 'summary'; certCode: string }
  | { name: 'settings' };

const APP_VERSION = __APP_VERSION__;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [version, setVersion] = useState(0); // DB가 바뀌면 올려서 화면을 다시 읽게 한다
  const [storageError, setStorageError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupBanner, setBackupBanner] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const stopRef = useRef(false);

  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4500);
  }, []);

  // 파일 선택기를 연 채로 앱이 다시 시작됨(클라우드 파일 여러 개를 내려받다 중단) → 안내(v0.10.7)
  useEffect(() => {
    if (interruptedPick()) void showNotice(INTERRUPTED_MESSAGE, { title: '문제팩 가져오기가 중단됨' });
  }, []);

  useEffect(() => {
    const onErr = (e: Event) => setStorageError((e as CustomEvent<string>).detail);
    window.addEventListener(STORAGE_ERROR_EVENT, onErr);
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, onErr);
  }, []);

  useEffect(() => {
    if (screen.name === 'home') backupDue().then((r) => setBackupBanner(r.due)).catch(() => undefined);
  }, [screen.name, version]);

  // 화면 전환 시 맨 위로. 중괄호 필수: Chrome 150대부터 scrollTo()가 Promise를 돌려주는데,
  // 화살표 함수가 그것을 반환하면 React가 정리 함수로 호출해 앱 전체가 멈춘다(2026-10-15 실기기 검은 화면)
  useEffect(() => {
    resetPageZoom(); // 확대한 채로 다음 화면에 가지 않게(v0.8.1)
    window.scrollTo(0, 0);
  }, [screen]);

  const importFiles = async (picked: File[], pickMs: number | null = null) => {
    setBusy(true);
    stopRef.current = false;
    markPickStart(); // 처리 도중 앱이 다시 시작돼도 다음 시작 때 안내되도록(끝나면 지움)
    const lines: string[] = [];
    let imported = 0;
    let identical = 0;
    let stoppedAt: number | null = null;
    const startedAt = Date.now();
    const imported_: ImportedSummary[] = [];
    let total = picked.length;
    const step = (done: number, name: string, phase: ImportProgress['phase']) =>
      setProgress((cur) => ({
        total,
        done,
        name,
        phase,
        startedAt,
        fileStartedAt: cur && cur.done === done && cur.name === name ? cur.fileStartedAt : Date.now(),
        stopping: stopRef.current,
      }));
    // 진행 창이 먼저 그려지도록 한 번 양보한다(큰 파일을 읽기 시작하면 화면이 한동안 멈출 수 있음)
    const yieldUi = () => new Promise<void>((r) => window.setTimeout(r, 0));
    // 묶음 파일(oneq-…-bundle-….zip)은 안의 팩들로 펼친다(v0.10.8). 보통 팩을 두 번 읽지 않도록 이름·크기로 먼저 거른다
    const files: { name: string; blob: Blob }[] = [];
    try {
      for (const [i, f] of picked.entries()) {
        if (/bundle|묶음/i.test(f.name) || f.size > 15 * 1024 * 1024) {
          step(i, f.name, 'read');
          await yieldUi();
          try {
            const inner = unbundle(new Uint8Array(await f.arrayBuffer()));
            if (inner?.length) {
              files.push(...inner);
              continue;
            }
          } catch (err) {
            lines.push(`${f.name}: ${describeError(err)}`);
            continue;
          }
        }
        files.push({ name: f.name, blob: f });
      }
      total = files.length;
      for (const [i, f] of files.entries()) {
        if (stopRef.current) {
          stoppedAt = i;
          break;
        }
        step(i, f.name, 'read');
        await yieldUi();
        const onPhase = (ph: ImportProgress['phase']) => step(i, f.name, ph);
        try {
          let r = await importPackFile(f.blob, { onPhase });
          if (r.status === 'same') {
            // 내용까지 같은 팩은 조용히 건너뛴다(여러 회차를 한꺼번에 다시 고른 경우). 학습 기록은 그대로
            if (r.identical) {
              identical++;
              continue;
            }
            if (await askConfirm(`${f.name}: 같은 버전(v${r.installedVersion})인데 내용이 다른 팩입니다. 새 것으로 바꿀까요? 학습 기록은 이어집니다`, { okText: '바꾸기' })) {
              r = await importPackFile(f.blob, { force: true, onPhase });
            } else continue;
          }
          if (r.status === 'imported') {
            imported++;
            const rec = r.reconcile;
            const extra = [
              r.replacedVersion !== null ? `v${r.replacedVersion}→v${r.manifest.packVersion} 교체` : '',
              rec.restored ? `기록 ${rec.restored}건 이어짐` : '',
              rec.moved ? `번호 바뀐 기록 ${rec.moved}건 옮김` : '',
              rec.pending ? `매핑 대기 ${rec.pending}건` : '',
            ].filter(Boolean);
            imported_.push({ cert: r.manifest.cert.name, label: examLabel(r.manifest), date: r.manifest.exam.date, questions: r.manifest.questionCount, bytes: r.bytes });
            if (extra.length) lines.push(`${examLabel(r.manifest)}: ${extra.join(' · ')}`);
          } else if (r.status === 'older') {
            lines.push(`${f.name}: 이미 더 새 버전(v${r.installedVersion})이 있어 건너뜀`);
          } else if (r.status === 'invalid') {
            lines.push(`${f.name}: 문제팩이 아니거나 손상됨 — ${describeIssues(r.issues)}`);
          }
        } catch (err) {
          lines.push(`${f.name}: ${describeError(err)}`);
        }
      }
      lines.unshift(...summarizeImported(imported_, formatBytes));
      if (identical) lines.push(`이미 있는 같은 팩 ${identical}개는 건너뜀(학습 기록 그대로)`);
      if (stoppedAt !== null) lines.push(`그만 가져오기: ${files.length}개 중 ${stoppedAt}개까지 처리, 나머지 ${files.length - stoppedAt}개는 가져오지 않음`);
      if (pickMs !== null && pickMs >= SLOW_PICK_MS) lines.push(SLOW_PICK_TIP);
      if (imported && navigator.storage?.persist) {
        // 첫 팩을 저장한 시점에 영구 저장을 요청한다(C3)
        const persisted = await navigator.storage.persisted();
        if (!persisted) await navigator.storage.persist().catch(() => false);
      }
    } finally {
      clearPick();
      setProgress(null);
      setBusy(false);
      bump();
      // 여러 개를 가져왔거나 멈췄으면 결과를 창으로(알림은 4.5초 뒤 사라져 놓치기 쉬움)
      if (files.length > 3 || picked.length > 3 || stoppedAt !== null) {
        if (lines.length) void showNotice(`${imported}개를 새로 가져왔습니다.\n\n${lines.join('\n')}`, { title: '문제팩 가져오기 결과' });
      } else if (lines.length) flash(lines.join('\n'));
    }
  };

  // 선택기에서 파일을 받지 못하고 돌아옴(클라우드 여러 개) → 안내(v0.10.8)
  const pickFailed = () => void showNotice(PICK_FAILED_MESSAGE, { title: '문제팩을 받지 못했습니다' });

  const go = (s: Screen) => {
    if (s.name === 'solve') setToast(null); // 알림이 풀이 화면 위쪽(진행·성적)을 가리지 않게
    setScreen(s);
    bump();
  };
  const home = () => go({ name: 'home' });

  return (
    <>
      <div className="top-banners">
        {needRefresh && screen.name !== 'solve' && (
          <div className="banner banner-update" role="status">
            <span>새 버전이 있습니다</span>
            <button className="btn btn-small" onClick={() => updateServiceWorker(true)}>
              지금 업데이트
            </button>
          </div>
        )}
        {storageError && (
          <div className="banner banner-error" role="alert">
            <span>⚠ 저장 실패 — {storageError}</span>
            <button className="btn btn-small btn-ghost" onClick={() => setStorageError(null)}>
              닫기
            </button>
          </div>
        )}
        {backupBanner && screen.name === 'home' && (
          <div className="banner banner-backup" role="status">
            <span>기록을 백업할 때가 됐습니다</span>
            <button className="btn btn-small" onClick={() => go({ name: 'settings' })}>
              백업하기
            </button>
          </div>
        )}
      </div>

      <ErrorBoundary key={JSON.stringify(screen)} onHome={home}>
      {screen.name === 'home' && (
        <Home
          version={version}
          busy={busy}
          onImport={importFiles}
          onPickFailed={pickFailed}
          onSolve={(target) => go({ name: 'solve', target })}
          onResult={(target) => go({ name: 'result', target })}
          onPack={(packId) => go({ name: 'pack', packId })}
          onSettings={() => go({ name: 'settings' })}
          onPlan={(certCode, certName) => go({ name: 'plan', certCode, certName })}
          onSummary={(certCode) => go({ name: 'summary', certCode })}
          toast={flash}
        />
      )}
      {screen.name === 'summary' && (
        <DaySummary certCode={screen.certCode} onHome={home} />
      )}
      {screen.name === 'plan' && <PlanSetup certCode={screen.certCode} certName={screen.certName} onBack={home} onSaved={flash} />}
      {screen.name === 'solve' && (
        <Solve target={screen.target} onExit={home} onResult={(peek) => go({ name: 'result', target: screen.target, back: peek ? 'solve' : undefined })} onSolve={(target) => go({ name: 'solve', target })} />
      )}
      {screen.name === 'result' && (
        <Result target={screen.target} onHome={home} onBack={screen.back === 'solve' ? () => go({ name: 'solve', target: screen.target }) : home} onSolve={(target) => go({ name: 'solve', target })} toast={flash} />
      )}
      {screen.name === 'pack' && (
        <PackDetail packId={screen.packId} onBack={() => go({ name: 'settings' })} onBackup={() => go({ name: 'settings' })} toast={flash} />
      )}
      {screen.name === 'settings' && (
        <Settings
          version={version}
          appVersion={APP_VERSION}
          swReady={offlineReady || !!navigator.serviceWorker?.controller}
          onBack={home}
          onChanged={bump}
          toast={flash}
          busy={busy}
          onImport={importFiles}
          onPickFailed={pickFailed}
          onPack={(packId) => go({ name: 'pack', packId })}
        />
      )}
      </ErrorBoundary>

      {progress && (
        <ImportProgressView
          p={progress}
          onStop={() => {
            stopRef.current = true;
            setProgress((cur) => (cur ? { ...cur, stopping: true } : cur));
          }}
        />
      )}
      <DialogHost />
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
