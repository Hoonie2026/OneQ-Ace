import Dexie from 'dexie';
import { useEffect, useState } from 'react';
import {
  backupDue,
  buildBackup,
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
import { deletePacks, wipeAll, wipeCertRecords, wipeRecords } from '../wipe';
import { deviceEnv, deviceSummary, formatBytes, readStorageInfo, storagePlace, type StorageInfo } from '../util';
import { examLabel } from '../study';
import { PackPicker } from './PackPicker';
import { askConfirm, showNotice } from './Dialog';
import type { PackRow } from '../db';
import { BackButton, Icon } from './Icon';
import { InstallGuide } from './InstallGuide';
import { MakerCard } from './MakerCard';

/** 백업 날짜 2026-11-18 */
function ymdOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 3분 전 · 2시간 전 · 5일 전 */
function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return m <= 1 ? '방금' : `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

export function Settings(props: {
  version: number;
  appVersion: string;
  swReady: boolean;
  onBack: () => void;
  onChanged: () => void;
  toast: (m: string) => void;
  busy: boolean;
  onImport: (files: File[], pickMs: number | null) => void;
  onPickFailed: () => void;
  onPack: (packId: string) => void;
}) {
  const [packs, setPacks] = useState<PackRow[]>([]);
  const [fp, setFp] = useState<Fingerprint | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [newSince, setNewSince] = useState(0);
  const [pending, setPending] = useState(0);
  const [info, setInfo] = useState<StorageInfo>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [certs, setCerts] = useState<{ code: string; name: string; packs: number; attempts: number }[]>([]);
  /** 이 기기 데이터 지우기(v0.7): 무엇을(기록 / 문제팩) · 어느 종목('*' = 모든 종목) · 어떤 팩 */
  const [wipeMode, setWipeMode] = useState<'records' | 'packs' | 'cert' | null>(null);
  const [wipeCert, setWipeCert] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href;

  const load = async () => {
    setFp(await fingerprint());
    setLastBackup(await getSetting<number | null>(SETTING.lastBackupAt, null));
    setNewSince((await backupDue()).newAttempts);
    setPending(await db.orphans.count());
    setInfo(await readStorageInfo());
    const packs = await db.packs.toArray();
    setPacks(
      [...packs].sort(
        (a, b) => a.manifest.cert.name.localeCompare(b.manifest.cert.name, 'ko') || b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round,
      ),
    );
    const map = new Map<string, { code: string; name: string; packs: number; attempts: number }>();
    for (const p of packs) {
      const c = map.get(p.manifest.cert.code) ?? { code: p.manifest.cert.code, name: p.manifest.cert.name, packs: 0, attempts: 0 };
      c.packs++;
      map.set(c.code, c);
    }
    for (const c of map.values()) c.attempts = await db.attempts.filter((a) => a.qid.startsWith(`${c.code}-`)).count();
    setCerts([...map.values()]);
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
      if (!(await askConfirm(msg, { title: '백업 복원', okText: '복원' }))) return;
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
      await showNotice('자동 복사가 안 됩니다. 아래 내용을 길게 눌러 복사하세요.', { copyText: text });
    }
  };

  const env = deviceEnv(navigator.userAgent, navigator.maxTouchPoints, isStandalone());
  const place = storagePlace(env);
  const days = lastBackup ? Math.floor((Date.now() - lastBackup) / 86_400_000) : null;
  // 백업 상태 색: 기록이 없거나 7일·300건 안이면 초록, 그보다 오래면 주황, 기록이 있는데 백업한 적 없으면 빨강
  const backupTone = fp && fp.attempts === 0 ? 'ok' : days === null ? 'bad' : days <= 7 && newSince < 300 ? 'ok' : 'warn';

  const byCert = certs.map((c) => ({ ...c, list: packs.filter((p) => p.manifest.cert.code === c.code) }));
  const storeIn = env.os === 'ios' && env.standalone ? '원큐합격 앱(Safari 저장소)' : `${env.browser} 브라우저`;
  const openWipe = (mode: 'records' | 'packs' | 'cert') => {
    setWipeMode(wipeMode === mode ? null : mode);
    setWipeCert(wipeCert && wipeCert !== '*' ? wipeCert : certs[0]?.code || '*');
    setPicked(new Set());
  };
  const certOptions = (all: boolean) => (
    <label className="field field-row">
      <span>자격종목을 선택하세요</span>
      <select
        value={wipeCert}
        onChange={(e) => {
          setWipeCert(e.target.value);
          setPicked(new Set());
        }}
        data-testid="wipe-cert"
      >
        {certs.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
        {all && <option value="*">모든 종목(이 기기 전체)</option>}
      </select>
    </label>
  );
  const recordsPanel = () => {
    const c = certs.find((x) => x.code === wipeCert);
    const what = wipeCert === '*' ? '모든 종목' : (c?.name ?? '');
    return (
      <div className="stack wipe-panel">
        {certOptions(true)}
        <button
          className="btn btn-danger btn-block"
          data-testid="wipe-records-go"
          onClick={async () => {
            if (!(await askConfirm(`${what}의 학습 기록(풀이·메모)을 지웁니다. 문제팩과 학습 계획은 그대로입니다. 되돌릴 수 없습니다. 백업했나요?`, { title: '학습기록 초기화', okText: '초기화', danger: true }))) return;
            if (wipeCert === '*') await wipeRecords();
            else await wipeCertRecords(wipeCert);
            props.toast(`${what}의 학습 기록을 지웠습니다. 문제팩은 그대로입니다`);
            setWipeMode(null);
            props.onChanged();
            await load();
          }}
        >
          {what} 학습기록 초기화
        </button>
      </div>
    );
  };
  const packsPanel = () => {
    const list = packs.filter((p) => p.manifest.cert.code === wipeCert);
    const allOn = list.length > 0 && list.every((p) => picked.has(p.packId));
    const name = certs.find((x) => x.code === wipeCert)?.name ?? '';
    const toggle = (id: string) =>
      setPicked((cur) => {
        const n = new Set(cur);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    return (
      <div className="stack wipe-panel">
        {certOptions(false)}
        <label className="check-line all">
          <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(list.map((p) => p.packId)))} data-testid="wipe-pick-all" />
          <span>
            전체 선택 <small className="muted">({list.length}회차)</small>
          </span>
        </label>
        <ul className="check-list">
          {list.map((p) => (
            <li key={p.packId}>
              <label className="check-line">
                <input type="checkbox" checked={picked.has(p.packId)} onChange={() => toggle(p.packId)} data-testid={`wipe-pick-${p.packId}`} />
                <span>
                  {examLabel(p.manifest)} <small className="muted">{p.manifest.questionCount}문항</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <button
          className="btn btn-danger btn-block"
          disabled={!picked.size}
          data-testid="wipe-packs-go"
          onClick={async () => {
            const ids = list.filter((p) => picked.has(p.packId)).map((p) => p.packId);
            if (!(await askConfirm(`${name} 문제팩 ${ids.length}개와 그 문항의 학습 기록을 지웁니다${allOn ? '(전체를 고르면 종목도 지워짐)' : ''}. 되돌릴 수 없습니다. 백업했나요?`, { title: '문제팩 지우기', okText: '지우기', danger: true }))) return;
            const r = await deletePacks(ids);
            props.toast(`${name} 문제팩 ${r.packs}개 삭제 · 풀이 기록 ${r.attempts}건 삭제${r.certsGone.length ? ' · 종목 삭제' : ''}`);
            setPicked(new Set());
            if (r.certsGone.length) setWipeCert('');
            props.onChanged();
            await load();
          }}
        >
          {picked.size ? `선택한 문제팩 ${picked.size}개 지우기` : '지울 문제팩을 고르세요'}
        </button>
      </div>
    );
  };
  const certPanel = () => {
    const c = certs.find((x) => x.code === wipeCert);
    return (
      <div className="stack wipe-panel">
        {certOptions(true)}
        {wipeCert === '*' ? (
          <button
            className="btn btn-danger btn-block"
            data-testid="wipe-all-go"
            onClick={async () => {
              if (!(await askConfirm(`모든 종목의 문제팩·학습 기록(${fp ? formatFingerprint(fp) : ''})·설정을 지웁니다. 백업했나요?`, { title: '모든 종목 지우기', okText: '지우기', danger: true }))) return;
              if (!(await askConfirm('정말 모두 지울까요? 되돌릴 수 없습니다.', { title: '마지막 확인', okText: '모두 지우기', danger: true }))) return;
              await wipeAll();
              await Dexie.delete(STAGE0_DB_NAME).catch(() => undefined);
              props.toast('모두 지웠습니다. 문제팩을 다시 등록하세요');
              props.onChanged();
              props.onBack();
            }}
          >
            모든 종목 지우기
          </button>
        ) : (
          <button
            className="btn btn-danger btn-block"
            data-testid="wipe-cert-go"
            onClick={async () => {
              if (!c) return;
              if (!(await askConfirm(`${c.name}의 문제팩 ${c.packs}회차·학습 기록(풀이 ${c.attempts}건)·학습 계획을 모두 지웁니다. 다른 종목은 그대로입니다. 되돌릴 수 없습니다. 백업했나요?`, { title: '자격종목 지우기', okText: '지우기', danger: true }))) return;
              const r = await deletePacks(packs.filter((p) => p.manifest.cert.code === c.code).map((p) => p.packId));
              props.toast(`${c.name} 종목을 지웠습니다(문제팩 ${r.packs}개 · 풀이 기록 ${r.attempts}건)`);
              setWipeCert('');
              setWipeMode(null);
              props.onChanged();
              await load();
            }}
          >
            {c?.name ?? ''} 종목 지우기
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="app">
      <header className="page-head">
        <BackButton label="홈" onClick={props.onBack} />
        <h1>문제팩·학습기록 설정</h1>
      </header>

      {/* v0.19.8(사용자 2026-11-18): 문제팩 관리 → 학습기록 관리 → 데이터 초기화 → 앱 정보 및 점검 → 학습앱 설치 안내 */}
      <section className="card set-packs" data-testid="pack-section">
        <h2>문제팩 관리</h2>
        <PackPicker busy={props.busy} onFiles={props.onImport} onPickFailed={props.onPickFailed} primary label="문제팩 등록하기" />
        {byCert.length > 0 && (
          <div className="cert-packs">
            {byCert.map((c) => (
              <details key={c.code} className="cert-pack" data-testid={`cert-pack-${c.code}`}>
                <summary>
                  <span className="cert-pack-name" title={c.name}>{c.name}</span>
                  <small className="muted">
                    {c.list.length}회차 · {c.list.reduce((n, p) => n + p.manifest.questionCount, 0).toLocaleString()}문항
                  </small>
                  <Icon name="chevron-down" size={18} className="cert-pack-arrow" />
                </summary>
                <ul className="round-chips">
                  {c.list.map((p) => (
                    <li key={p.packId} data-testid={`pack-${p.packId}`}>
                      {examLabel(p.manifest)} <small className="muted">{p.manifest.questionCount}문항</small>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="card data-safety" data-testid="data-safety">
        <h2>학습기록 관리</h2>
        {place.warn && (
          <p className="safety-warn" data-testid="storage-warn" role="note">
            <Icon name="alert" size={18} /> {place.warn}
          </p>
        )}
        <div className="backup-row">
          <button className="btn btn-primary" disabled={busy} onClick={() => doExport('download')} data-testid="backup-go">
            학습기록 백업하기
          </button>
          <span className={`backup-last ${backupTone}`} data-testid="backup-status" title={lastBackup ? `마지막 백업 ${new Date(lastBackup).toLocaleString('ko-KR')} (${ago(lastBackup)})` : '마지막 백업 없음'}>
            {lastBackup ? `백업 ${ymdOf(lastBackup)}` : '백업 기록 없음'}
          </span>
        </div>
        <p className="hint" data-testid="storage-where">
          학습기록은 이 기기 <b>{storeIn}</b>에 저장 중으로, 인터넷 사용기록·쿠키 및 사이트 데이터 삭제 시 같이 삭제되므로 정기적으로 백업하세요.
        </p>
        <label className={`btn btn-block${busy ? ' disabled' : ''}`}>
          백업파일 업데이트(학습기록 가져오기)
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
        <p className="hint">다른 기기 학습기록 백업파일이나 이전 이 기기 학습기록을 업데이트하여 학습을 이어갈 수 있습니다.</p>
        {report && (
          <div className={`report ${report.matchesBackup ? 'ok' : 'warn'}`} data-testid="restore-report" role="status">
            <p>
              <b>{report.matchesBackup ? '업데이트 완료 — 백업과 기록 일치' : '업데이트 완료 — 확인 필요'}</b>
            </p>
            <p>
              새로 들어간 풀이 {report.added}건 · 이미 있던 풀이 {report.skipped}건 · 메모 {report.notes}건
              {report.plansUpdated > 0 && ` · 더 최신 학습 계획 ${report.plansUpdated}개 반영`}
            </p>
            <p>지금: {formatFingerprint(report.after)}</p>
            {report.reconcile.pending > 0 && (
              <p>
                매핑 대기 {report.reconcile.pending}건 — 아래 문제팩을 이 기기에도 등록하면 자동으로 이어집니다:
                <br />
                {report.missingPacks.map((p) => p.title).join(', ') || '(원래 팩의 내용이 바뀜)'}
              </p>
            )}
          </div>
        )}
        {pending > 0 && !report && <p className="hint warn-text">매핑 대기 {pending}건: 해당 문제팩을 다시 등록하면 기록이 이어집니다.</p>}
      </section>

      <section className="card" id="wipe" data-testid="wipe-section">
        <h2>데이터 초기화</h2>
        {/* v0.19.9: 단추와 그 아래 하위 메뉴를 한 블록 안에 — 어느 작업인지 한눈에 */}
        <div className="wipe-btns">
          {(
            [
              ['records', '학습기록만 초기화', 'wipe-records', recordsPanel],
              ['packs', '문제팩 지우기', 'wipe', packsPanel],
              ['cert', '자격종목 지우기', 'wipe-cert-mode', certPanel],
            ] as const
          ).map(([mode, label, testId, panel]) => (
            <div key={mode} className={`wipe-block${wipeMode === mode ? ' on' : ''}`}>
              <button className="wipe-btn" aria-expanded={wipeMode === mode} data-testid={testId} disabled={!certs.length} onClick={() => openWipe(mode)}>
                <span>{label}</span>
                <Icon name={wipeMode === mode ? 'chevron-up' : 'chevron-down'} size={18} />
              </button>
              {wipeMode === mode && panel()}
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>원큐합격 앱 정보</h2>
        <pre className="diag">
          {diagText()
            .split('\n')
            .map((l, i) =>
              l.startsWith('- 기록: ') && fp ? (
                <span key={i}>
                  - 기록: <span data-testid="fingerprint">{formatFingerprint(fp)}</span>
                  {l.slice(`- 기록: ${formatFingerprint(fp)}`.length)}
                  {'\n'}
                </span>
              ) : (
                <span key={i}>
                  {l}
                  {'\n'}
                </span>
              ),
            )}
        </pre>
      </section>

      {/* 보내기·설치 — 설치 루트 재설계(사용자 2026-11-12 세션 #19): 모든 시작은 학습앱 링크 하나. 생성기 링크는 따로 보내지 않음 */}
      <section className="card address">
        <h2>원큐합격 앱 설치 안내</h2>
        <p className="link-line">
          <b>학습앱 링크</b>
          <span className="url" title={appUrl}>{appUrl.replace(/^https?:\/\//, '')}</span>
        </p>
        <p className="hint">카카오톡·메일 등으로 보내면, 받은 사람은 링크를 열어 PC·휴대폰에 학습앱을 설치합니다.</p>
        <div className="test-actions">
          <button className="btn btn-small" onClick={() => copy(appUrl, '학습앱 링크를 복사했습니다')} data-testid="copy-app-link">
            학습앱 링크 복사
          </button>
          {'share' in navigator && (
            <button className="btn btn-small" onClick={() => navigator.share({ title: '원큐합격 학습앱', url: appUrl }).catch(() => undefined)}>
              링크 공유하기
            </button>
          )}
        </div>
        <details className="why" data-testid="install-how">
          <summary>학습앱 설치 방법 — PC(Windows) · 모바일(Android·iPhone)</summary>
          <InstallGuide url={appUrl} onCopy={() => copy(appUrl, '학습앱 주소를 복사했습니다')} testId="install-guide-settings" />
        </details>
        <details className="why" data-testid="maker-how">
          <summary>문제팩을 직접 만들려면 — 원큐합격 문제팩 생성기</summary>
          <MakerCard testId="maker-card-settings" />
        </details>
      </section>
    </div>
  );
}
