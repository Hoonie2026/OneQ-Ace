import { useEffect, useState } from 'react';
import { loadCoach, startMock, startToday, type Coach } from '../coach';
import { db, describeError, getSetting, isStandalone, setSetting, SETTING } from '../db';
import { ensureWrongRun, examLabel, packSummary, type PackSummary, type Target } from '../study';
import { CoachCard } from './CoachCard';
import { MockPanel } from './MockPanel';
import { PackPicker } from './PackPicker';

type Tab = 'rounds' | 'mock';

interface Cert {
  code: string;
  name: string;
  packs: number;
}

export function Home(props: {
  version: number;
  busy: boolean;
  onImport: (files: File[]) => void;
  onSolve: (t: Target) => void;
  onResult: (t: Target) => void;
  onPack: (packId: string) => void;
  onSettings: () => void;
  onPlan: (certCode: string, certName: string) => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const [coach, setCoach] = useState<Coach | null>(null);
  const [tab, setTab] = useState<Tab>('rounds');
  const [starting, setStarting] = useState(false);
  const [items, setItems] = useState<PackSummary[] | null>(null);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [cert, setCert] = useState<string | null>(null);
  const [subjectFor, setSubjectFor] = useState<PackSummary | null>(null);

  useEffect(() => {
    (async () => {
      const packs = (await db.packs.toArray()).sort(
        (a, b) => b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round,
      );
      // 자격종목별로 나눈다. 고른 종목은 기억해 두고, 없으면 가장 최근에 가져온 팩의 종목
      const map = new Map<string, Cert>();
      for (const p of packs) {
        const c = map.get(p.manifest.cert.code) ?? { code: p.manifest.cert.code, name: p.manifest.cert.name, packs: 0 };
        c.packs++;
        map.set(c.code, c);
      }
      const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const saved = await getSetting<string | null>(SETTING.certCode, null);
      const newest = [...packs].sort((a, b) => b.importedAt - a.importedAt)[0]?.manifest.cert.code ?? null;
      const chosen = saved && map.has(saved) ? saved : newest;
      setCerts(list);
      setCert(chosen);
      setItems(await Promise.all(packs.filter((p) => p.manifest.cert.code === chosen).map((p) => packSummary(p))));
      setCoach(chosen ? await loadCoach(chosen) : null);
    })();
  }, [props.version]);

  const pickCert = async (code: string) => {
    await setSetting(SETTING.certCode, code);
    const packs = (await db.packs.toArray())
      .filter((p) => p.manifest.cert.code === code)
      .sort((a, b) => b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round);
    setCert(code);
    setItems(await Promise.all(packs.map((p) => packSummary(p))));
    setCoach(await loadCoach(code));
  };

  /** 오늘 학습·모의고사 시작(엔진이 문항을 고른다) */
  const start = async (kind: 'today' | 'mock') => {
    if (!cert || starting) return;
    setStarting(true);
    try {
      const t = kind === 'today' ? await startToday(cert) : await startMock(cert);
      if (t) props.onSolve(t);
      else props.toast(kind === 'today' ? '오늘 낼 문항이 없습니다. 학습 계획(시험일)을 확인하세요' : '모의고사를 만들 문항이 없습니다');
    } catch (err) {
      props.toast(`시작하지 못했습니다: ${describeError(err)}`);
    } finally {
      setStarting(false);
    }
  };
  const mockCount = coach ? coach.ctx.bank.subjects.filter((x) => x.current).reduce((t, x) => t + x.examCount, 0) : 0;

  const certName = certs.find((c) => c.code === cert)?.name;
  // 이어 풀기: 이 종목에서 가장 최근에 풀던 것(회독 미완료 또는 오답 묶음)
  const recent = (items ?? [])
    .filter((i) => (i.pass && i.answered > 0 && i.answered < i.total) || i.wrongRun)
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            1Q
          </span>
          <div>
            <h1>원큐합격</h1>
            <p className="sub">{certName ?? '기사·산업기사 필기 기출'}</p>
          </div>
        </div>
        <button className="icon-btn" onClick={props.onSettings} aria-label="백업·설정">
          ⚙
        </button>
      </header>

      {certs.length > 1 && (
        <nav className="cert-tabs" aria-label="자격종목 선택">
          {certs.map((c) => (
            <button key={c.code} className={`cert-tab${c.code === cert ? ' on' : ''}`} aria-pressed={c.code === cert} onClick={() => pickCert(c.code)}>
              {c.name}
              <small>{c.packs}회차</small>
            </button>
          ))}
        </nav>
      )}

      {!isStandalone() && (
        <section className="card guide">
          <h2>홈 화면에 설치해서 쓰세요</h2>
          <p className="hint">
            설치한 앱에서만 기록이 오래 보존됩니다. Android Chrome: ⋮ → <b>앱 설치</b> / iPhone Safari: 공유 → <b>홈 화면에 추가</b>
          </p>
        </section>
      )}

      {coach && cert && (
        <CoachCard
          coach={coach}
          certCode={cert}
          busy={starting}
          onPlan={() => props.onPlan(cert, certName ?? cert)}
          onToday={() => start('today')}
          onResumeToday={(sessionId) => props.onSolve({ kind: 'set', sessionId })}
          onChanged={props.onChanged}
          toast={props.toast}
        />
      )}

      {items && items.length > 0 && (
        <nav className="tabs" role="tablist" aria-label="학습 방법">
          <button role="tab" aria-selected={tab === 'rounds'} className={`tab${tab === 'rounds' ? ' on' : ''}`} onClick={() => setTab('rounds')}>
            회차별
          </button>
          <button role="tab" aria-selected={tab === 'mock'} className={`tab${tab === 'mock' ? ' on' : ''}`} onClick={() => setTab('mock')} data-testid="tab-mock">
            모의고사
          </button>
        </nav>
      )}

      {tab === 'mock' && cert && items && items.length > 0 && (
        <MockPanel
          certCode={cert}
          version={props.version}
          busy={starting}
          questionCount={mockCount}
          onStart={() => start('mock')}
          onOpen={(sessionId, finished) => (finished ? props.onResult({ kind: 'set', sessionId }) : props.onSolve({ kind: 'set', sessionId }))}
        />
      )}

      {tab === 'rounds' && recent && (
        <section className="card resume" data-testid="resume">
          <p className="muted">이어 풀기</p>
          {recent.wrongRun && recent.wrongRun.updatedAt >= (recent.pass?.updatedAt ?? 0) ? (
            <>
              <h2>{recent.wrongRun.title}</h2>
              <p className="hint">{recent.wrongRunLeft}문항 남음</p>
              <button className="btn btn-primary btn-block btn-big" onClick={() => props.onSolve({ kind: 'wrong', sessionId: recent.wrongRun!.sessionId })}>
                이어서 풀기
              </button>
            </>
          ) : (
            <>
              <h2>
                {examLabel(recent.pack.manifest)} · {recent.passNo}회독
              </h2>
              <p className="hint">
                {recent.answered} / {recent.total}문항 풀이
              </p>
              <button className="btn btn-primary btn-block btn-big" onClick={() => props.onSolve({ kind: 'pass', packId: recent.pack.packId })}>
                이어서 풀기
              </button>
            </>
          )}
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

      {tab === 'rounds' && items && items.length > 0 && (
        <section>
          <div className="section-head">
            <h2>문제팩 {items.length}회차</h2>
            <PackPicker busy={props.busy} onFiles={props.onImport} small />
          </div>
          <ul className="packs">
            {items.map((it) => {
              const done = it.answered >= it.total;
              const target: Target = { kind: 'pass', packId: it.pack.packId };
              return (
                <li key={it.pack.packId} className="card pack" data-testid={`pack-${it.pack.packId}`}>
                  <button className="pack-title" onClick={() => props.onPack(it.pack.packId)}>
                    <span>
                      <b>{examLabel(it.pack.manifest)}</b>
                      <small className="muted">
                        {it.pack.manifest.questionCount}문항 · {it.passNo}회독
                      </small>
                    </span>
                    <span className="muted" aria-hidden="true">
                      ›
                    </span>
                  </button>
                  <div className="meter" aria-label={`진도 ${it.answered}/${it.total}`}>
                    <div className="meter-bar" style={{ width: `${(it.answered / Math.max(1, it.total)) * 100}%` }} />
                  </div>
                  <p className="meter-text" data-testid="pack-progress">
                    진도 {it.answered}/{it.total}
                    {it.wrongNow > 0 && ` · 다시 볼 문항 ${it.wrongNow}`}
                  </p>
                  <div className="pack-actions">
                    {done ? (
                      <button className="btn btn-primary" onClick={() => props.onResult(target)}>
                        결과 보기
                      </button>
                    ) : (
                      <button className="btn btn-primary" data-testid="pack-solve" onClick={() => props.onSolve(target)}>
                        {it.answered === 0 ? '풀기 시작' : `이어 풀기 ${it.answered}/${it.total}`}
                      </button>
                    )}
                    <button className="btn" onClick={() => setSubjectFor(it)}>
                      과목별
                    </button>
                    {it.answered > 0 && !done && (
                      <button className="btn" onClick={() => props.onResult(target)}>
                        성적
                      </button>
                    )}
                    {it.wrongNow > 0 && (
                      <button
                        className="btn"
                        onClick={async () => {
                          const run = await ensureWrongRun(it.pack.packId);
                          if (run) props.onSolve({ kind: 'wrong', sessionId: run.sessionId });
                        }}
                      >
                        {it.wrongRun ? `오답·모름 이어 풀기 ${it.wrongRunLeft}` : `오답·모름 ${it.wrongNow}`}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {subjectFor && (
        <div className="sheet-back" onClick={() => setSubjectFor(null)}>
          <div className="sheet" role="dialog" aria-label="과목 선택" onClick={(e) => e.stopPropagation()}>
            <h2>{examLabel(subjectFor.pack.manifest)} 과목별 풀기</h2>
            <p className="hint">과목별로 푼 문항도 회차 진도에 함께 쌓입니다.</p>
            {subjectFor.pack.manifest.subjects.map((sub) => {
              const b = subjectFor.bySubject.get(sub.no) ?? { answered: 0, total: sub.count };
              const t: Target = { kind: 'pass', packId: subjectFor.pack.packId, subjectNo: sub.no };
              const full = b.answered >= b.total;
              return (
                <button
                  key={sub.no}
                  className="btn btn-block sheet-item"
                  onClick={() => {
                    setSubjectFor(null);
                    if (full) props.onResult(t);
                    else props.onSolve(t);
                  }}
                >
                  <span>
                    {sub.no}과목 {sub.name}
                  </span>
                  <small className={full ? 'ok-text' : 'muted'}>
                    {full ? '완료 · 결과' : `${b.answered}/${b.total}`}
                  </small>
                </button>
              );
            })}
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
