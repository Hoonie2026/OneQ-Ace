import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { backupDue } from './backup';
import { describeError, STORAGE_ERROR_EVENT } from './db';
import { describeIssues, importPackFile } from './pack/import';
import { examLabel } from './study';
import { formatBytes } from './util';
import { Home } from './ui/Home';
import { PackDetail } from './ui/PackDetail';
import { Result } from './ui/Result';
import { Settings } from './ui/Settings';
import { Solve } from './ui/Solve';

type Screen =
  | { name: 'home' }
  | { name: 'solve'; sessionId: string }
  | { name: 'result'; sessionId: string }
  | { name: 'pack'; packId: string }
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

  // 화면 전환 시 맨 위로
  useEffect(() => window.scrollTo(0, 0), [screen]);

  const importFiles = async (files: File[]) => {
    setBusy(true);
    const lines: string[] = [];
    let imported = 0;
    try {
      for (const f of files) {
        try {
          let r = await importPackFile(f);
          if (r.status === 'same' && window.confirm(`${f.name}: 이미 가져온 팩(v${r.installedVersion})입니다. 다시 저장할까요?`)) {
            r = await importPackFile(f, { force: true });
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

      {screen.name === 'home' && (
        <Home
          version={version}
          busy={busy}
          onImport={importFiles}
          onStart={(sessionId) => go({ name: 'solve', sessionId })}
          onPack={(packId) => go({ name: 'pack', packId })}
          onSettings={() => go({ name: 'settings' })}
        />
      )}
      {screen.name === 'solve' && (
        <Solve sessionId={screen.sessionId} onExit={home} onFinish={(sessionId) => go({ name: 'result', sessionId })} />
      )}
      {screen.name === 'result' && (
        <Result sessionId={screen.sessionId} onHome={home} onStart={(sessionId) => go({ name: 'solve', sessionId })} />
      )}
      {screen.name === 'pack' && (
        <PackDetail packId={screen.packId} onBack={home} onBackup={() => go({ name: 'settings' })} toast={flash} />
      )}
      {screen.name === 'settings' && (
        <Settings
          version={version}
          appVersion={APP_VERSION}
          swReady={offlineReady || !!navigator.serviceWorker?.controller}
          onBack={home}
          onChanged={bump}
          toast={flash}
        />
      )}

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
