import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { db, isStandalone, saveResult, STORAGE_ERROR_EVENT, type ResultRow, type TestStatus } from './db';
import {
  buildReport,
  exportSampleZip,
  onLaunch,
  readStorageInfo,
  TEST_LABELS,
  testBackupExport,
  testBackupRestore,
  testDummyPack,
  testEstimate,
  testImportZip,
  testPersist,
  type StorageInfo,
} from './tests';
import { deviceSummary, formatBytes, formatTime } from './util';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const STATUS_LABEL: Record<TestStatus, string> = { pass: '통과', fail: '실패', check: '확인 필요', idle: '미실행' };
const STATUS_ICON: Record<TestStatus, string> = { pass: '✓', fail: '✕', check: '?', idle: '·' };

export default function App() {
  const [results, setResults] = useState<Map<string, ResultRow>>(new Map());
  const [info, setInfo] = useState<StorageInfo>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState('');
  const [storageError, setStorageError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const standalone = isStandalone();
  const launched = useRef(false);

  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });

  const refresh = useCallback(async () => {
    const rows = await db.results.toArray();
    setResults(new Map(rows.map((r) => [r.id, r])));
    setInfo(await readStorageInfo());
  }, []);

  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    const controlled = !!navigator.serviceWorker?.controller;
    onLaunch(controlled)
      .catch(() => undefined)
      .finally(refresh);
  }, [refresh]);

  useEffect(() => {
    const onErr = (e: Event) => setStorageError((e as CustomEvent<string>).detail);
    const onOnline = () => setOnline(navigator.onLine);
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener(STORAGE_ERROR_EVENT, onErr);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    window.addEventListener('beforeinstallprompt', onInstall);
    return () => {
      window.removeEventListener(STORAGE_ERROR_EVENT, onErr);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
      window.removeEventListener('beforeinstallprompt', onInstall);
    };
  }, []);

  useEffect(() => () => preview.forEach((u) => URL.revokeObjectURL(u)), [preview]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setProgress('');
    try {
      await fn();
    } catch (err) {
      flash(`오류: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      setProgress('');
      await refresh();
    }
  };

  const mark = (id: string, status: TestStatus) =>
    run(`mark-${id}`, async () => {
      const prev = results.get(id);
      const base = (prev?.detail ?? '').replace(/[.]?\s*[^.]*표시하세요/, '').replace(/\s*\[사용자 확인: [^\]]+\]/, '');
      await saveResult(id, status, `${base} [사용자 확인: ${STATUS_LABEL[status]}]`.trim());
    });

  const showPreview = async (packId: string) => {
    const rows = await db.blobs.where('packId').equals(packId).limit(5).toArray();
    preview.forEach((u) => URL.revokeObjectURL(u));
    setPreview(rows.map((r) => URL.createObjectURL(r.data)));
  };

  const copyReport = () =>
    run('report', async () => {
      const text = await buildReport();
      try {
        await navigator.clipboard.writeText(text);
        flash('결과를 복사했습니다. 대화창에 붙여 넣어 주세요');
      } catch {
        if (navigator.share) {
          await navigator.share({ text });
        } else {
          window.prompt('아래 내용을 길게 눌러 복사하세요', text);
        }
      }
    });

  const shareReport = () =>
    run('report-share', async () => {
      const text = await buildReport();
      if (!navigator.share) {
        flash('이 브라우저는 공유를 지원하지 않습니다. 결과 복사를 쓰세요');
        return;
      }
      try {
        await navigator.share({ title: '원큐합격 0단계 결과', text });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
      }
    });

  const resetAll = async () => {
    if (!window.confirm('검증 데이터(30MB 팩, 결과, 실행 기록)를 모두 지웁니다. 계속할까요?')) return;
    if (!window.confirm('정말 지울까요? 결과를 복사하지 않았다면 먼저 복사하세요.')) return;
    await db.delete();
    window.location.reload();
  };

  const usagePct = info.usage !== undefined && info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0;
  const done = [...results.values()].filter((r) => r.status === 'pass').length;
  const total = Object.keys(TEST_LABELS).length;

  const r = (id: string) => results.get(id);

  return (
    <div className="app">
      {needRefresh && (
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

      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            1Q
          </span>
          <div>
            <h1>원큐합격</h1>
            <p className="sub">0단계 · 실기기 저장 검증</p>
          </div>
        </div>
        <div className="score" aria-label={`통과 ${done} / ${total}`}>
          <strong>{done}</strong>
          <span>/{total} 통과</span>
        </div>
      </header>

      <section className="card env">
        <dl>
          <div>
            <dt>기기</dt>
            <dd>{deviceSummary()}</dd>
          </div>
          <div>
            <dt>실행 방식</dt>
            <dd className={standalone ? 'ok' : 'warn'}>{standalone ? '홈 화면 앱' : '브라우저 탭'}</dd>
          </div>
          <div>
            <dt>네트워크</dt>
            <dd>{online ? '온라인' : '오프라인'}</dd>
          </div>
          <div>
            <dt>오프라인 준비</dt>
            <dd className={offlineReady || navigator.serviceWorker?.controller ? 'ok' : ''}>
              {offlineReady || navigator.serviceWorker?.controller ? '완료' : '준비 중'}
            </dd>
          </div>
          <div>
            <dt>영구 저장</dt>
            <dd className={info.persisted ? 'ok' : 'warn'}>{info.persisted ? '허용' : '미허용'}</dd>
          </div>
        </dl>
        <div className="meter" aria-label="저장공간 사용량">
          <div className="meter-bar" style={{ width: `${Math.max(usagePct, 0.5)}%` }} />
        </div>
        <p className="meter-text">
          사용 {formatBytes(info.usage)} / 한도 {formatBytes(info.quota)}
        </p>
      </section>

      {!standalone && (
        <section className="card guide">
          <h2>먼저 홈 화면에 설치하세요</h2>
          <p>설치한 앱에서 시험해야 실제 사용 환경과 같습니다.</p>
          {installEvt ? (
            <button
              className="btn btn-primary btn-block"
              onClick={async () => {
                await installEvt.prompt();
                setInstallEvt(null);
              }}
            >
              앱 설치
            </button>
          ) : (
            <ul className="steps">
              <li>
                <b>Android Chrome</b>: 오른쪽 위 ⋮ → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>
              </li>
              <li>
                <b>iPhone Safari</b>: 아래 공유 버튼 → <b>홈 화면에 추가</b>
              </li>
            </ul>
          )}
          <p className="hint">설치 후 홈 화면의 「원큐합격」 아이콘으로 다시 여세요.</p>
        </section>
      )}

      <section className="card order">
        <h2>진행 순서</h2>
        <ol>
          <li>T3 → T4 → T5를 차례로 누르기</li>
          <li>앱을 완전히 닫고(최근 앱 목록에서 밀어 닫기) 다시 열기 → T6 자동 확인</li>
          <li>비행기 모드를 켜고 앱 열기 → T2 자동 확인, 다시 끄기</li>
          <li>T7 → T8 → T9 진행</li>
          <li>맨 아래 <b>결과 복사</b> 후 대화창에 붙여 넣기</li>
        </ol>
      </section>

      <ul className="tests">
        <TestCard id="T1" row={r('T1')} note="홈 화면 아이콘으로 열면 자동 통과" />
        <TestCard id="T2" row={r('T2')} note="비행기 모드에서 앱을 열면 자동 확인" />
        <TestCard id="T3" row={r('T3')}>
          <button className="btn" disabled={!!busy} onClick={() => run('T3', testPersist)}>
            영구 저장 요청
          </button>
        </TestCard>
        <TestCard id="T4" row={r('T4')}>
          <button className="btn" disabled={!!busy} onClick={() => run('T4', testEstimate)}>
            사용량 조회
          </button>
        </TestCard>
        <TestCard id="T5" row={r('T5')} progress={busy === 'T5' ? progress || '준비 중…' : ''}>
          <button className="btn" disabled={!!busy} onClick={() => run('T5', () => testDummyPack(setProgress))}>
            30MB 저장·검증
          </button>
        </TestCard>
        <TestCard id="T6" row={r('T6')} note="T5 후 앱을 닫았다 다시 열면 자동 확인" />
        <TestCard id="T7" row={r('T7')} onMark={(s) => mark('T7', s)}>
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => run('T7-sample', async () => flash(await exportSampleZip()))}>
            ① 샘플 팩 받기
          </button>
          <label className={`btn${busy ? ' disabled' : ''}`}>
            ② 팩 가져오기
            <input
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f)
                  run('T7', async () => {
                    const { previewPackId } = await testImportZip(f);
                    if (previewPackId) await showPreview(previewPackId);
                  });
              }}
            />
          </label>
        </TestCard>
        {preview.length > 0 && (
          <li className="preview" aria-label="가져온 문항 이미지 미리보기">
            {preview.map((u, i) => (
              <img key={u} src={u} alt={`샘플 문항 ${i + 1}`} />
            ))}
          </li>
        )}
        <TestCard id="T8a" row={r('T8a')} onMark={(s) => mark('T8a', s)}>
          <button className="btn" disabled={!!busy} onClick={() => run('T8a', () => testBackupExport('share'))}>
            공유 시트로 내보내기
          </button>
        </TestCard>
        <TestCard id="T8b" row={r('T8b')} onMark={(s) => mark('T8b', s)}>
          <button className="btn" disabled={!!busy} onClick={() => run('T8b', () => testBackupExport('download'))}>
            다운로드로 내보내기
          </button>
        </TestCard>
        <TestCard id="T9" row={r('T9')}>
          <label className={`btn${busy ? ' disabled' : ''}`}>
            백업 파일 열기
            <input
              type="file"
              accept=".json,application/json"
              hidden
              disabled={!!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) run('T9', () => testBackupRestore(f));
              }}
            />
          </label>
        </TestCard>
      </ul>

      <section className="actions">
        <button className="btn btn-primary btn-block" disabled={!!busy} onClick={copyReport}>
          결과 복사
        </button>
        <button className="btn btn-block" disabled={!!busy} onClick={shareReport}>
          결과 공유(메신저로 보내기)
        </button>
        <button className="btn btn-danger btn-block" disabled={!!busy} onClick={resetAll}>
          검증 데이터 전체 삭제
        </button>
        <p className="foot">서버 없음 · 데이터 수집 없음 · 모든 기록은 이 기기에만 저장됩니다</p>
      </section>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function TestCard(props: {
  id: string;
  row?: ResultRow;
  note?: string;
  progress?: string;
  onMark?: (s: TestStatus) => void;
  children?: ReactNode;
}) {
  const status: TestStatus = props.row?.status ?? 'idle';
  return (
    <li className={`test s-${status}`}>
      <div className="test-head">
        <span className="badge" aria-hidden="true">
          {STATUS_ICON[status]}
        </span>
        <div className="test-title">
          <span className="test-id">{props.id}</span>
          <h3>{TEST_LABELS[props.id]}</h3>
        </div>
        <span className="chip">{STATUS_LABEL[status]}</span>
      </div>
      {props.row ? (
        <p className="detail">
          {props.row.detail}
          <span className="time">
            {formatTime(props.row.at)} · {props.row.standalone ? '홈 화면 앱' : '브라우저 탭'}
          </span>
        </p>
      ) : props.note ? (
        <p className="detail muted">{props.note}</p>
      ) : null}
      {props.progress && <p className="progress">{props.progress}</p>}
      {(props.children || (props.onMark && status === 'check')) && (
        <div className="test-actions">
          {props.children}
          {props.onMark && status === 'check' && (
            <>
              <button className="btn btn-small btn-ok" onClick={() => props.onMark!('pass')}>
                통과로 표시
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => props.onMark!('fail')}>
                실패로 표시
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
