import Dexie from 'dexie';
import { useEffect, useState } from 'react';
import {
  buildBackup,
  canShareFiles,
  exportBackup,
  fingerprint,
  formatFingerprint,
  markBackedUp,
  parseBackup,
  restoreBackup,
  BackupFormatError,
  type Fingerprint,
  type RestoreReport,
} from '../backup';
import { db, describeError, getSetting, isStandalone, SETTING, STAGE0_DB_NAME } from '../db';
import { deviceSummary, formatBytes, readStorageInfo, type StorageInfo } from '../util';

export function Settings(props: {
  version: number;
  appVersion: string;
  swReady: boolean;
  onBack: () => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const [fp, setFp] = useState<Fingerprint | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [info, setInfo] = useState<StorageInfo>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [stage0, setStage0] = useState(false);
  const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href;

  const load = async () => {
    setFp(await fingerprint());
    setLastBackup(await getSetting<number | null>(SETTING.lastBackupAt, null));
    setPending(await db.orphans.count());
    setInfo(await readStorageInfo());
    setStage0(await Dexie.exists(STAGE0_DB_NAME).catch(() => false));
  };
  useEffect(() => {
    load();
  }, [props.version]);

  const doExport = async (mode: 'download' | 'share') => {
    setBusy(true);
    try {
      const { json, name } = await buildBackup(props.appVersion);
      const out = await exportBackup(json, name, mode);
      if (out === 'downloaded' || out === 'shared') {
        await markBackedUp();
        props.toast(mode === 'download' ? `${name}을 다운로드 폴더에 저장했습니다` : '공유 시트로 보냈습니다. 받은 곳에 파일이 있는지 확인하세요');
      } else if (out === 'unsupported') props.toast('이 브라우저는 파일 공유를 지원하지 않습니다. 다운로드를 쓰세요');
      await load();
    } catch (err) {
      props.toast(`백업 실패: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (file: File) => {
    setBusy(true);
    setReport(null);
    try {
      const b = parseBackup(await file.text());
      const msg = `${new Date(b.createdAt).toLocaleString('ko-KR')}에 만든 백업(${formatFingerprint(b.fingerprint)})을 이 기기 기록에 합칩니다.\n같은 기록은 한 번만 들어갑니다. 계속할까요?`;
      if (!window.confirm(msg)) return;
      const r = await restoreBackup(b);
      setReport(r);
      props.onChanged();
      await load();
    } catch (err) {
      props.toast(err instanceof BackupFormatError ? err.message : `복원 실패: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const requestPersist = async () => {
    if (!navigator.storage?.persist) return props.toast('이 브라우저는 영구 저장 요청을 지원하지 않습니다');
    const ok = await navigator.storage.persist();
    props.toast(ok ? '영구 저장이 허용됐습니다' : '거부됐습니다. 홈 화면에 설치한 앱에서 다시 시도하세요');
    await load();
  };

  const diagText = () =>
    [
      `원큐합격 ${props.appVersion} 점검`,
      `- 기기: ${deviceSummary()}`,
      `- 실행: ${isStandalone() ? '홈 화면 앱' : '브라우저 탭'} · ${navigator.onLine ? '온라인' : '오프라인'} · 오프라인 준비 ${props.swReady ? '완료' : '미완료'}`,
      `- 저장공간: 사용 ${formatBytes(info.usage)} / 한도 ${formatBytes(info.quota)} · 영구 저장 ${info.persisted ? '허용' : '미허용'}`,
      `- 기록: ${fp ? formatFingerprint(fp) : '?'} · 매핑 대기 ${pending}건`,
      `- 마지막 백업: ${lastBackup ? new Date(lastBackup).toLocaleString('ko-KR') : '없음'}`,
      `- 시각: ${new Date().toLocaleString('ko-KR')}`,
    ].join('\n');

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      props.toast(done);
    } catch {
      window.prompt('아래 내용을 길게 눌러 복사하세요', text);
    }
  };

  const usagePct = info.usage !== undefined && info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0;

  return (
    <div className="app">
      <header className="page-head">
        <button className="icon-btn" onClick={props.onBack} aria-label="뒤로">
          ‹
        </button>
        <h1>백업·설정</h1>
      </header>

      <section className="card">
        <h2>학습 기록 백업</h2>
        <p className="fp" data-testid="fingerprint">
          {fp ? formatFingerprint(fp) : '…'}
        </p>
        <p className="hint">
          마지막 백업: {lastBackup ? new Date(lastBackup).toLocaleString('ko-KR') : '아직 없음'}. 앱을 지우거나 휴대폰을 바꾸면 기록이 사라지므로 주기적으로 저장하세요.
          문제팩은 백업에 들어가지 않습니다(다시 가져오면 기록이 이어짐).
        </p>
        <div className="stack">
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => doExport('download')}>
            백업 파일 저장(다운로드)
          </button>
          {canShareFiles() && (
            <button className="btn btn-block" disabled={busy} onClick={() => doExport('share')}>
              공유로 보내기(드라이브·메신저)
            </button>
          )}
          <label className={`btn btn-block${busy ? ' disabled' : ''}`}>
            백업 파일에서 복원(.json·.txt)
            <input
              type="file"
              accept=".json,.txt,application/json,text/plain"
              hidden
              disabled={busy}
              data-testid="restore-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) doRestore(f);
              }}
            />
          </label>
        </div>
        {report && (
          <div className={`report ${report.matchesBackup ? 'ok' : 'warn'}`} data-testid="restore-report" role="status">
            <p>
              <b>{report.matchesBackup ? '✓ 복원 완료 — 백업과 기록 일치' : '! 복원 완료 — 확인 필요'}</b>
            </p>
            <p>
              새로 들어간 풀이 {report.added}건 · 이미 있던 풀이 {report.skipped}건 · 메모 {report.notes}건
            </p>
            <p>지금: {formatFingerprint(report.after)}</p>
            {report.reconcile.pending > 0 && (
              <p>
                매핑 대기 {report.reconcile.pending}건 — 아래 문제팩을 다시 가져오면 자동으로 이어집니다:
                <br />
                {report.missingPacks.map((p) => p.title).join(', ') || '(원래 팩의 내용이 바뀜)'}
              </p>
            )}
          </div>
        )}
        {pending > 0 && !report && (
          <p className="hint warn-text">매핑 대기 {pending}건: 해당 문제팩을 다시 가져오면 기록이 이어집니다.</p>
        )}
      </section>

      <section className="card">
        <h2>저장공간</h2>
        <div className="meter" aria-label="저장공간 사용량">
          <div className="meter-bar" style={{ width: `${Math.max(usagePct, 0.5)}%` }} />
        </div>
        <p className="meter-text">
          사용 {formatBytes(info.usage)} / 한도 {formatBytes(info.quota)}
        </p>
        <p className={info.persisted ? 'ok-text' : 'warn-text'}>
          영구 저장: {info.persisted ? '허용됨 — 기기 공간이 부족해도 브라우저가 지우지 않습니다' : '미허용 — 기기 공간이 부족하면 지워질 수 있습니다'}
        </p>
        {!info.persisted && (
          <button className="btn btn-small" onClick={requestPersist}>
            영구 저장 요청
          </button>
        )}
        {stage0 && (
          <div className="stack">
            <p className="hint">0단계 실기기 검증에 쓴 시험 데이터(약 30MB)가 남아 있습니다.</p>
            <button
              className="btn btn-small"
              onClick={async () => {
                if (!window.confirm('0단계 검증 데이터만 지웁니다(학습 기록과 무관). 계속할까요?')) return;
                await Dexie.delete(STAGE0_DB_NAME);
                props.toast('0단계 검증 데이터를 지웠습니다');
                await load();
              }}
            >
              0단계 검증 데이터 지우기
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>앱 정보·점검</h2>
        <pre className="diag">{diagText()}</pre>
        <div className="test-actions">
          <button className="btn btn-small" onClick={() => copy(diagText(), '점검 결과를 복사했습니다')}>
            점검 결과 복사
          </button>
        </div>
      </section>

      <section className="card address">
        <h2>앱 주소</h2>
        <p className="url">{appUrl}</p>
        <p className="hint">다른 휴대폰에서는 Chrome(iPhone은 Safari) 주소창에 이 주소를 입력하고 설치하세요.</p>
        <div className="test-actions">
          <button className="btn btn-small" onClick={() => copy(appUrl, '주소를 복사했습니다')}>
            주소 복사
          </button>
          {'share' in navigator && (
            <button className="btn btn-small" onClick={() => navigator.share({ title: '원큐합격', url: appUrl }).catch(() => undefined)}>
              주소 보내기
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
