import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { backupDue } from './backup';
import { describeError, STORAGE_ERROR_EVENT } from './db';
import { describeIssues, importPackBytes } from './pack/import';
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
import { DialogHost, showNotice } from './ui/Dialog';
import { ImportProgressView } from './ui/ImportProgressView';
import { clearPick, INTERRUPTED_MESSAGE, interruptedPick, markPickStart, PICK_FAILED_MESSAGE, SLOW_PICK_MS, SLOW_PICK_TIP, summarizeImported, type ImportedSummary, type ImportProgress } from './importFlow';
import { unbundle } from './pack/bundle';
import { installPromptOpen, onInstallChange, useInstalledApp } from './install';

type Screen =
  | { name: 'home'; view?: 'subjects' | 'rounds' }
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

  // 브라우저 화면(설치 안내만 보이는 곳)에서는 새 버전을 묻지 않고 조용히 바꾼다(사용자 2026-11-16: 앱을 지우고 다시 설치하는데
  // 예전 기록 때문에 '설치하고 있어요'와 '새 버전이 있습니다'가 함께 떠 충돌이 걱정됨). 설치 창이 떠 있는 동안만 기다림 —
  // 설치는 Chrome이 맡으므로 페이지를 새로 고쳐도 끊기지 않고, '설치하고 있어요'는 새로 고친 뒤에도 이어서 보인다
  const installedApp = useInstalledApp();
  const [promptTick, setPromptTick] = useState(0);
  useEffect(() => onInstallChange(() => setPromptTick((t) => t + 1)), []);
  useEffect(() => {
    if (needRefresh && !installedApp && !installPromptOpen()) void updateServiceWorker(true);
  }, [needRefresh, installedApp, promptTick, updateServiceWorker]);

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
    // 문제팩 생성기가 만드는 파일은 종목 묶음 하나(「원큐합격 문제팩_종목_연도(n회차).zip」, 2026-11-17) — 이름과 관계없이
    // 안을 보고 묶음이면 팩들로 펼친다(예전 oneq-…-bundle-… 이름도 같음). 회차 팩 하나짜리 zip은 그대로
    // 고른 파일은 한 번만 읽는다 — 읽어 보고 묶음이면 그 자리에서 안의 팩들로 펼친다(진행 창의 전체 수도 늘어남)
    const files: { name: string; get: () => Blob; picked?: boolean }[] = picked.map((f) => ({ name: f.name, get: () => f, picked: true }));
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (stopRef.current) {
          stoppedAt = i;
          break;
        }
        total = files.length;
        step(i, f.name, 'read');
        await yieldUi();
        const onPhase = (ph: ImportProgress['phase']) => step(i, f.name, ph);
        let data: Uint8Array;
        try {
          data = new Uint8Array(await f.get().arrayBuffer()); // 묶음 안 팩은 이때 하나씩 꺼낸다(ADR 021 8절)
          if (f.picked) {
            const inner = unbundle(data);
            if (inner?.length) {
              files.splice(i, 1, ...inner.map((e) => ({ name: e.name, get: e.load })));
              i--;
              continue;
            }
          }
        } catch (err) {
          lines.push(`${f.name}: ${describeError(err)}`);
          continue;
        }
        try {
          // 이미 있는 회차는 묻지 않고 덮어쓴다(판과 관계없이, 사용자 2026-11-17). 학습 기록은 이어짐. 내용까지 같으면 그대로
          const r = await importPackBytes(data, { overwrite: true, onPhase });
          if (r.status === 'same') {
            identical++;
            continue;
          }
          if (r.status === 'imported') {
            imported++;
            const rec = r.reconcile;
            const extra = [
              r.replacedVersion !== null ? '이미 있던 회차를 덮어씀' : '',
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
      if (identical) lines.push(`이미 있는 같은 회차 ${identical}개는 그대로(내용이 같음, 학습 기록 그대로)`);
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
        {needRefresh && installedApp && screen.name !== 'solve' && (
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
          initialView={screen.view}
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
        <Solve target={screen.target} onExit={(view) => go({ name: 'home', view })} onResult={(peek) => go({ name: 'result', target: screen.target, back: peek ? 'solve' : undefined })} onSolve={(target) => go({ name: 'solve', target })} />
      )}
      {screen.name === 'result' && (
        <Result target={screen.target} onHome={(view) => go({ name: 'home', view })} onBack={screen.back === 'solve' ? () => go({ name: 'solve', target: screen.target }) : home} onSolve={(target) => go({ name: 'solve', target })} toast={flash} />
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
