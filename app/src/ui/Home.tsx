import { useEffect, useState } from 'react';
import { db, isStandalone, type PackRow, type RunRow } from '../db';
import { examLabel, openRuns, packProgress, startRun, type PackProgress } from '../study';
import { PackPicker } from './PackPicker';

interface Item {
  pack: PackRow;
  prog: PackProgress;
  round?: RunRow;
}

export function Home(props: {
  version: number;
  busy: boolean;
  onImport: (files: File[]) => void;
  onStart: (sessionId: string) => void;
  onPack: (packId: string) => void;
  onSettings: () => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [resume, setResume] = useState<RunRow | null>(null);
  const [subjectFor, setSubjectFor] = useState<PackRow | null>(null);

  useEffect(() => {
    (async () => {
      const packs = (await db.packs.toArray()).sort(
        (a, b) => b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round,
      );
      const runs = await openRuns();
      const ids = new Set(packs.map((p) => p.packId));
      const live = runs.filter((r) => ids.has(r.packId) && Object.keys(r.answered).length < r.qids.length);
      setResume(live[0] ?? null);
      setItems(
        await Promise.all(
          packs.map(async (pack) => ({
            pack,
            prog: await packProgress(pack.packId),
            round: live.find((r) => r.packId === pack.packId && r.mode === 'round'),
          })),
        ),
      );
    })();
  }, [props.version]);

  const begin = async (packId: string, mode: 'round' | 'wrong', subjectNo?: number) => {
    const run = await startRun(packId, subjectNo ? 'subject' : mode, { subjectNo });
    if (run) props.onStart(run.sessionId);
  };

  const certs = [...new Set(items?.map((i) => i.pack.manifest.cert.name) ?? [])];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            1Q
          </span>
          <div>
            <h1>원큐합격</h1>
            <p className="sub">{certs.length ? certs.join(' · ') : '기사·산업기사 필기 기출'}</p>
          </div>
        </div>
        <button className="icon-btn" onClick={props.onSettings} aria-label="백업·설정">
          ⚙
        </button>
      </header>

      {!isStandalone() && (
        <section className="card guide">
          <h2>홈 화면에 설치해서 쓰세요</h2>
          <p className="hint">
            설치한 앱에서만 기록이 오래 보존됩니다. Android Chrome: ⋮ → <b>앱 설치</b> / iPhone Safari: 공유 → <b>홈 화면에 추가</b>
          </p>
        </section>
      )}

      {resume && (
        <section className="card resume">
          <p className="muted">이어 풀기</p>
          <h2>{resume.title}</h2>
          <p className="hint">
            {Object.keys(resume.answered).length} / {resume.qids.length}문항 풀이
          </p>
          <button className="btn btn-primary btn-block btn-big" onClick={() => props.onStart(resume.sessionId)}>
            이어서 풀기
          </button>
        </section>
      )}

      {items && items.length === 0 && (
        <section className="card empty">
          <h2>문제팩을 가져오세요</h2>
          <p>
            사내 게시판에서 받은 <b>oneq-종목-연도-회차.zip</b> 파일을 고릅니다. 여러 개를 한 번에 골라도 됩니다.
          </p>
          <PackPicker busy={props.busy} onFiles={props.onImport} primary />
        </section>
      )}

      {items && items.length > 0 && (
        <section>
          <div className="section-head">
            <h2>내 문제팩 {items.length}개</h2>
            <PackPicker busy={props.busy} onFiles={props.onImport} small />
          </div>
          <ul className="packs">
            {items.map(({ pack, prog, round }) => (
              <li key={pack.packId} className="card pack" data-testid={`pack-${pack.packId}`}>
                <button className="pack-title" onClick={() => props.onPack(pack.packId)}>
                  <span>
                    <b>{examLabel(pack.manifest)}</b>
                    <small className="muted">{pack.manifest.cert.name}</small>
                  </span>
                  <span className="muted" aria-hidden="true">
                    ›
                  </span>
                </button>
                <div className="meter" aria-label={`진도 ${prog.solved}/${prog.total}`}>
                  <div className="meter-bar" style={{ width: `${(prog.solved / Math.max(1, prog.total)) * 100}%` }} />
                </div>
                <p className="meter-text">
                  진도 {prog.solved}/{prog.total}
                  {prog.wrongNow > 0 && ` · 다시 볼 문항 ${prog.wrongNow}`}
                </p>
                <div className="pack-actions">
                  {round ? (
                    <button className="btn btn-primary" onClick={() => props.onStart(round.sessionId)}>
                      이어 풀기 {Object.keys(round.answered).length}/{round.qids.length}
                    </button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => begin(pack.packId, 'round')}>
                      회차 풀기
                    </button>
                  )}
                  <button className="btn" onClick={() => setSubjectFor(pack)}>
                    과목별
                  </button>
                  {prog.wrongNow > 0 && (
                    <button className="btn" onClick={() => begin(pack.packId, 'wrong')}>
                      오답·모름 {prog.wrongNow}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {subjectFor && (
        <div className="sheet-back" onClick={() => setSubjectFor(null)}>
          <div className="sheet" role="dialog" aria-label="과목 선택" onClick={(e) => e.stopPropagation()}>
            <h2>{examLabel(subjectFor.manifest)} 과목 선택</h2>
            {subjectFor.manifest.subjects.map((s) => (
              <button
                key={s.no}
                className="btn btn-block sheet-item"
                onClick={() => {
                  setSubjectFor(null);
                  begin(subjectFor.packId, 'round', s.no);
                }}
              >
                {s.no}과목 {s.name} <small className="muted">{s.count}문항</small>
              </button>
            ))}
            <button className="btn btn-ghost btn-block" onClick={() => setSubjectFor(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      <p className="foot">서버 없음 · 데이터 수집 없음 · 모든 기록은 이 기기에만 저장됩니다</p>
    </div>
  );
}
