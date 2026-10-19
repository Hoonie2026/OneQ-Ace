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
import { deletePacks, wipeAll, wipeCertRecords, wipeRecords } from '../wipe';
import { deviceSummary, formatBytes, readStorageInfo, type StorageInfo } from '../util';
import { examLabel } from '../study';
import { PackPicker } from './PackPicker';
import { askConfirm, showNotice } from './Dialog';
import type { PackRow } from '../db';

export function Settings(props: {
  version: number;
  appVersion: string;
  swReady: boolean;
  onBack: () => void;
  onChanged: () => void;
  toast: (m: string) => void;
  busy: boolean;
  onImport: (files: File[]) => void;
  onPack: (packId: string) => void;
}) {
  const [packs, setPacks] = useState<PackRow[]>([]);
  const [fp, setFp] = useState<Fingerprint | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [info, setInfo] = useState<StorageInfo>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [stage0, setStage0] = useState(false);
  const [certs, setCerts] = useState<{ code: string; name: string; packs: number; attempts: number }[]>([]);
  /** 이 기기 데이터 지우기(v0.7): 무엇을(기록 / 문제팩) · 어느 종목('*' = 모든 종목) · 어떤 팩 */
  const [wipeMode, setWipeMode] = useState<'records' | 'packs' | null>(null);
  const [wipeCert, setWipeCert] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href;

  const load = async () => {
    setFp(await fingerprint());
    setLastBackup(await getSetting<number | null>(SETTING.lastBackupAt, null));
    setPending(await db.orphans.count());
    setInfo(await readStorageInfo());
    setStage0(await Dexie.exists(STAGE0_DB_NAME).catch(() => false));
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
      await showNotice('자동 복사가 안 됩니다. 아래 내용을 길게 눌러 복사하세요.', { copyText: text });
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
                if (!(await askConfirm('0단계 검증 데이터만 지웁니다(학습 기록과 무관). 계속할까요?', { okText: '지우기', danger: true }))) return;
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

      <section className="card" data-testid="pack-section">
        <div className="section-head">
          <h2>문제팩 {packs.length}회차</h2>
          <PackPicker busy={props.busy} onFiles={props.onImport} small />
        </div>
        <p className="hint">가져온 문제팩 현황입니다. 회차를 누르면 정보를 봅니다. 지우기는 아래 <b>이 기기 데이터 지우기 → 문제팩 지우기</b>에서 합니다.</p>
        <ul className="pack-lines">
          {packs.map((p) => (
            <li key={p.packId}>
              <button className="pack-line" onClick={() => props.onPack(p.packId)} data-testid={`pack-${p.packId}`}>
                <span>{examLabel(p.manifest)}</span>
                <small className="muted">
                  {p.manifest.cert.name} · {p.manifest.questionCount}문항
                </small>
                <span className="muted" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>자격종목 관리</h2>
        {certs.length === 0 ? (
          <p className="hint">가져온 문제팩이 없습니다.</p>
        ) : (
          <ul className="cert-list">
            {certs.map((c) => (
              <li key={c.code}>
                <span>
                  <b>{c.name}</b>
                  <small className="muted">
                    문제팩 {c.packs}회차 · 풀이 {c.attempts}건
                  </small>
                </span>
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    // 종목 삭제 = 그 종목 문제팩 전체 + 학습 기록 + 학습 계획. 삭제는 아래 한 곳에서(전체 선택된 상태로 연다)
                    setWipeMode('packs');
                    setWipeCert(c.code);
                    setPicked(new Set(packs.filter((p) => p.manifest.cert.code === c.code).map((p) => p.packId)));
                    window.setTimeout(() => document.getElementById('wipe')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                  }}
                >
                  종목 삭제
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">종목 삭제는 그 종목의 문제팩·학습 기록·학습 계획을 모두 지웁니다(다른 종목은 그대로).</p>
      </section>

      <section className="card" id="wipe" data-testid="wipe-section">
        <h2>이 기기 데이터 지우기</h2>
        <p className="hint">
          Android에서 앱 아이콘을 삭제해도 데이터는 Chrome에 남습니다(다시 설치하면 그대로 보임). 다시 시작하거나 휴대폰을 넘길 때, 합격한 종목을 정리할 때 여기서
          지웁니다. 되돌릴 수 없으니 먼저 백업하세요.
        </p>
        <div className="seg" role="tablist">
          <button
            role="tab"
            aria-selected={wipeMode === 'records'}
            className={`seg-btn${wipeMode === 'records' ? ' on' : ''}`}
            data-testid="wipe-records"
            onClick={() => {
              setWipeMode(wipeMode === 'records' ? null : 'records');
              setWipeCert(wipeCert || certs[0]?.code || '*');
            }}
          >
            학습 기록만 지우기
          </button>
          <button
            role="tab"
            aria-selected={wipeMode === 'packs'}
            className={`seg-btn${wipeMode === 'packs' ? ' on' : ''}`}
            data-testid="wipe"
            onClick={() => {
              setWipeMode(wipeMode === 'packs' ? null : 'packs');
              setWipeCert(wipeCert || certs[0]?.code || '*');
              setPicked(new Set());
            }}
          >
            문제팩 지우기
          </button>
        </div>
        {wipeMode && (
          <div className="stack wipe-panel">
            <label className="field">
              <span>자격종목</span>
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
                <option value="*">모든 종목(이 기기 전체)</option>
              </select>
            </label>
            {wipeMode === 'records' && (() => {
              const c = certs.find((x) => x.code === wipeCert);
              return (
                <>
                  <p className="hint">
                    {wipeCert === '*' ? `모든 종목의 학습 기록(${fp ? formatFingerprint(fp) : ''})` : `${c?.name}의 학습 기록(풀이 ${c?.attempts ?? 0}건·메모·학습 묶음)`}을 지웁니다. 문제팩과 학습 계획은 그대로입니다.
                  </p>
                  <button
                    className="btn btn-danger btn-block"
                    data-testid="wipe-records-go"
                    onClick={async () => {
                      const what = wipeCert === '*' ? '모든 종목' : c?.name;
                      if (!(await askConfirm(`${what}의 학습 기록을 지웁니다. 되돌릴 수 없습니다. 백업 파일을 저장했나요?`, { title: '학습 기록 지우기', okText: '지우기', danger: true }))) return;
                      if (wipeCert === '*') await wipeRecords();
                      else await wipeCertRecords(wipeCert);
                      props.toast(`${what}의 학습 기록을 지웠습니다. 문제팩은 그대로입니다`);
                      setWipeMode(null);
                      props.onChanged();
                      await load();
                    }}
                  >
                    {wipeCert === '*' ? '모든 종목 학습 기록 지우기' : `${c?.name ?? ''} 학습 기록 지우기`}
                  </button>
                </>
              );
            })()}
            {wipeMode === 'packs' && wipeCert === '*' && (
              <>
                <p className="hint">모든 종목의 문제팩·학습 기록·설정을 지웁니다(휴대폰을 넘길 때).</p>
                <button
                  className="btn btn-danger btn-block"
                  data-testid="wipe-all-go"
                  onClick={async () => {
                    if (!(await askConfirm(`문제팩과 학습 기록(${fp ? formatFingerprint(fp) : ''})을 모두 지웁니다. 백업 파일을 저장했나요?`, { title: '모두 지우기', okText: '지우기', danger: true }))) return;
                    if (!(await askConfirm('정말 모두 지울까요? 되돌릴 수 없습니다.', { title: '마지막 확인', okText: '모두 지우기', danger: true }))) return;
                    await wipeAll();
                    await Dexie.delete(STAGE0_DB_NAME).catch(() => undefined);
                    props.toast('모두 지웠습니다. 문제팩을 다시 가져오세요');
                    props.onChanged();
                    props.onBack();
                  }}
                >
                  모두 지우기
                </button>
              </>
            )}
            {wipeMode === 'packs' && wipeCert !== '*' && (() => {
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
                <>
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
                  <p className="hint">
                    고른 문제팩과 <b>그 문제팩 문항의 학습 기록(풀이·메모)</b>을 함께 지웁니다.
                    {allOn ? ` 전체를 고르면 ${name} 종목이 없어지고 학습 계획도 지워집니다.` : ''}
                  </p>
                  <button
                    className="btn btn-danger btn-block"
                    disabled={!picked.size}
                    data-testid="wipe-packs-go"
                    onClick={async () => {
                      const ids = list.filter((p) => picked.has(p.packId)).map((p) => p.packId);
                      if (!(await askConfirm(`${name} 문제팩 ${ids.length}개와 그 학습 기록을 지웁니다${allOn ? '(종목 삭제)' : ''}. 되돌릴 수 없습니다. 백업 파일을 저장했나요?`, { title: '문제팩 지우기', okText: '지우기', danger: true }))) return;
                      const r = await deletePacks(ids);
                      props.toast(`${name} 문제팩 ${r.packs}개 삭제 · 풀이 기록 ${r.attempts}건 삭제${r.certsGone.length ? ' · 종목 삭제' : ''}`);
                      setPicked(new Set());
                      if (r.certsGone.length) setWipeCert('');
                      props.onChanged();
                      await load();
                    }}
                  >
                    {picked.size ? `선택한 문제팩 ${picked.size}개 삭제(학습 기록 포함)` : '지울 문제팩을 고르세요'}
                  </button>
                </>
              );
            })()}
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
