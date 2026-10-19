import { useCallback, useEffect, useState } from 'react';
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
import { askConfirm, DialogHost } from './ui/Dialog';

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

  const importFiles = async (files: File[]) => {
    setBusy(true);
    const lines: string[] = [];
    let imported = 0;
    let identical = 0;
    try {
      for (const f of files) {
        try {
          let r = await importPackFile(f);
          if (r.status === 'same') {
            // 내용까지 같은 팩은 조용히 건너뛴다(여러 회차를 한꺼번에 다시 고른 경우). 학습 기록은 그대로
            if (r.identical) {
              identical++;
              continue;
            }
            if (await askConfirm(`${f.name}: 같은 버전(v${r.installedVersion})인데 내용이 다른 팩입니다. 새 것으로 바꿀까요? 학습 기록은 이어집니다`, { okText: '바꾸기' })) {
              r = await importPackFile(f, { force: true });
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
            lines.push(`${examLabel(r.manifest)} ${r.manifest.questionCount}문항 (${formatBytes(r.bytes)})${extra.length ? ' · ' + extra.join(' · ') : ''}`);
          } else if (r.status === 'older') {
            lines.push(`${f.name}: 이미 더 새 버전(v${r.installedVersion})이 있어 건너뜀`);
          } else if (r.status === 'invalid') {
            lines.push(`${f.name}: 문제팩이 아니거나 손상됨 — ${describeIssues(r.issues)}`);
          }
        } catch (err) {
          lines.push(`${f.name}: ${describeError(err)}`);
        }
      }
      if (identical) lines.push(`이미 있는 같은 팩 ${identical}개는 건너뜀(학습 기록 그대로)`);
      if (imported && navigator.storage?.persist) {
        // 첫 팩을 저장한 시점에 영구 저장을 요청한다(C3)
        const persisted = await navigator.storage.persisted();
        if (!persisted) await navigator.storage.persist().catch(() => false);
      }
    } finally {
      setBusy(false);
      bump();
      if (lines.length) flash(lines.join('\n'));
    }
  };

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
        <Solve target={screen.target} onExit={home} onResult={(peek) => go({ name: 'result', target: screen.target, back: peek ? 'solve' : undefined })} onSolve={(target) => go({ name: 'solve', target })} onSummary={(certCode) => go({ name: 'summary', certCode })} />
      )}
      {screen.name === 'result' && (
        <Result target={screen.target} onHome={home} onBack={screen.back === 'solve' ? () => go({ name: 'solve', target: screen.target }) : home} onSolve={(target) => go({ name: 'solve', target })} onSummary={(certCode) => go({ name: 'summary', certCode })} toast={flash} />
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
          onPack={(packId) => go({ name: 'pack', packId })}
        />
      )}
      </ErrorBoundary>

      <DialogHost />
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
