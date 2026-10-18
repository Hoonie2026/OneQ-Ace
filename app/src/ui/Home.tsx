import { useEffect, useState } from 'react';
import { loadCoach, startMock, startSubject, startToday, type Coach } from '../coach';
import { db, describeError, getSetting, isStandalone, setSetting, SETTING, type PackRow } from '../db';
import type { Target } from '../study';
import { CoachCard } from './CoachCard';
import { MockPanel } from './MockPanel';
import { PackPicker } from './PackPicker';
import { SubjectList } from './SubjectList';

/** 홈 안의 보기: 홈 / 과목 골라서 / 모의고사(ADR 010 — 홈에는 오늘 학습만, 나머지는 한 번 더 들어가서) */
type View = 'home' | 'subjects' | 'mock';

interface Cert {
  code: string;
  name: string;
  packs: number;
}

/**
 * 홈(ADR 008·009): 종목 → [시험일 | D-day, 현재 ☞ 계획 이행 시, 오늘 학습] → [과목별 | 모의고사].
 * 회차별 풀이는 없앴고, 문제팩 관리는 설정 화면으로 옮겼다(처음 가져올 때만 여기서).
 */
export function Home(props: {
  version: number;
  busy: boolean;
  onImport: (files: File[]) => void;
  onSolve: (t: Target) => void;
  onResult: (t: Target) => void;
  onPack: (packId: string) => void;
  onSettings: () => void;
  onPlan: (certCode: string, certName: string) => void;
  onSummary: (certCode: string) => void;
  toast: (m: string) => void;
}) {
  const [packs, setPacks] = useState<PackRow[] | null>(null);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [cert, setCert] = useState<string | null>(null);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [view, setView] = useState<View>('home');
  const [starting, setStarting] = useState(false);

  const loadCert = async (code: string | null, all: PackRow[]) => {
    setPacks(all.filter((p) => p.manifest.cert.code === code));
    setCoach(code ? await loadCoach(code) : null);
  };

  useEffect(() => {
    (async () => {
      const all = await db.packs.toArray();
      const map = new Map<string, Cert>();
      for (const p of all) {
        const c = map.get(p.manifest.cert.code) ?? { code: p.manifest.cert.code, name: p.manifest.cert.name, packs: 0 };
        c.packs++;
        map.set(c.code, c);
      }
      const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      const saved = await getSetting<string | null>(SETTING.certCode, null);
      const newest = [...all].sort((a, b) => b.importedAt - a.importedAt)[0]?.manifest.cert.code ?? null;
      const chosen = saved && map.has(saved) ? saved : newest;
      setCerts(list);
      setCert(chosen);
      await loadCert(chosen, all);
    })();
  }, [props.version]);

  const pickCert = async (code: string) => {
    await setSetting(SETTING.certCode, code);
    setCert(code);
    await loadCert(code, await db.packs.toArray());
  };

  const certName = certs.find((c) => c.code === cert)?.name;
  const mockCount = coach ? coach.ctx.bank.subjects.filter((x) => x.current).reduce((t, x) => t + x.examCount, 0) : 0;

  /** 과목 학습·모의고사 시작(엔진이 문항을 고른다) */
  const start = async (kind: 'today' | 'subject' | 'mock', subjectKey?: string) => {
    if (!cert || starting) return;
    setStarting(true);
    try {
      const t = kind === 'today' ? await startToday(cert) : kind === 'subject' ? await startSubject(cert, subjectKey!) : await startMock(cert);
      if (t) props.onSolve(t);
      else props.toast(kind === 'mock' ? '모의고사를 만들 문항이 없습니다' : '오늘 낼 문항이 없습니다. 내일 복습이 준비됩니다');
    } catch (err) {
      props.toast(`시작하지 못했습니다: ${describeError(err)}`);
    } finally {
      setStarting(false);
    }
  };

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

      {packs && packs.length === 0 && (
        <section className="card empty">
          <h2>문제팩을 가져오세요</h2>
          <p>
            사내 게시판에서 받은 <b>oneq-종목-연도-회차.zip</b> 파일을 고릅니다. 여러 회차를 한 번에 골라도 됩니다(5~10년치를 권장).
          </p>
          <PackPicker busy={props.busy} onFiles={props.onImport} primary />
        </section>
      )}

      {coach && cert && packs && packs.length > 0 && (
        <>
          {view === 'home' && (
            <CoachCard
              coach={coach}
              busy={starting}
              onPlan={() => props.onPlan(cert, certName ?? cert)}
              onToday={() => start('today')}
              onResume={(sessionId) => props.onSolve({ kind: 'set', sessionId })}
              onFinish={() => props.onSummary(cert)}
              onSubjects={() => setView('subjects')}
              onMock={() => setView('mock')}
            />
          )}
          {view !== 'home' && (
            <header className="page-head sub-head">
              <button className="icon-btn" onClick={() => setView('home')} aria-label="홈으로">
                ‹
              </button>
              <h1>{view === 'subjects' ? '과목 골라서 학습' : '모의고사'}</h1>
            </header>
          )}
          {view === 'subjects' && <SubjectList coach={coach} busy={starting} onStudy={(k) => start('subject', k)} />}
          {view === 'mock' && (
            <MockPanel
              certCode={cert}
              version={props.version}
              busy={starting}
              questionCount={mockCount}
              onStart={() => start('mock')}
              onOpen={(sessionId, finished) => (finished ? props.onResult({ kind: 'set', sessionId }) : props.onSolve({ kind: 'set', sessionId }))}
            />
          )}
        </>
      )}

      <p className="foot">서버 없음 · 데이터 수집 없음 · 모든 기록은 이 기기에만 저장됩니다</p>
    </div>
  );
}
