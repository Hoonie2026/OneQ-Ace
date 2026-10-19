import { useEffect, useState } from 'react';
import { loadCoach, mockHistory, startMock, startSubject, startToday, type Coach } from '../coach';
import { RecommendView } from './RecommendView';
import { db, describeError, getSetting, isStandalone, setSetting, SETTING, type PackRow } from '../db';
import type { Target } from '../study';
import { CoachCard } from './CoachCard';
import { MockPanel } from './MockPanel';
import { PackPicker } from './PackPicker';
import { SubjectList } from './SubjectList';
import { ForecastView } from './ForecastView';
import { Principles } from './Principles';
import { computeInsight, type Insight } from '../insight';

/** 홈 안의 보기: 홈 / 과목 골라서 / 모의고사(ADR 010 — 홈에는 오늘 학습만, 나머지는 한 번 더 들어가서) */
type View = 'home' | 'recommend' | 'subjects' | 'mock' | 'forecast' | 'principles';

const TITLES: Record<Exclude<View, 'home'>, string> = {
  recommend: '시스템 추천 학습',
  subjects: '과목별 학습',
  mock: '모의고사',
  forecast: '예상 점수 계산',
  principles: '학습 원리',
};

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
  const [lastMock, setLastMock] = useState<{ date: string; score: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [insight, setInsight] = useState<Insight | null>(null);

  // 보기를 바꾸면 맨 위부터(학습 원리 단추는 홈 맨 아래에 있다)
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [view]);

  // 합격 가능성·실제 학습량 점검은 계산이 무거워(이분 탐색) 홈을 먼저 그린 뒤 채운다
  useEffect(() => {
    setInsight(null);
    if (!coach) return;
    const id = setTimeout(() => {
      try {
        setInsight(computeInsight(coach));
      } catch {
        setInsight(null);
      }
    }, 30);
    return () => clearTimeout(id);
  }, [coach]);

  const loadCert = async (code: string | null, all: PackRow[]) => {
    setPacks(all.filter((p) => p.manifest.cert.code === code));
    setCoach(code ? await loadCoach(code) : null);
    const m = code ? (await mockHistory(code)).find((x) => x.finished) : undefined;
    setLastMock(m ? { date: new Date(m.startedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }), score: m.result.avgScore } : null);
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
        <label className="cert-select">
          <span>자격종목</span>
          <select value={cert ?? ''} onChange={(e) => pickCert(e.target.value)} aria-label="자격종목 선택" data-testid="cert-select">
            {certs.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
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
              insight={insight}
              onForecast={() => setView('forecast')}
              onPrinciples={() => setView('principles')}
              busy={starting}
              lastMock={lastMock}
              onPlan={() => props.onPlan(cert, certName ?? cert)}
              onRecommend={() => setView('recommend')}
              onResume={(sessionId) => props.onSolve({ kind: 'set', sessionId })}
              onFinish={() => props.onSummary(cert)}
              onSubjects={() => setView('subjects')}
              onMock={() => setView('mock')}
            />
          )}
          {view !== 'home' && (
            <header className="page-head sub-head">
              <button className="back-btn" onClick={() => setView('home')} aria-label="홈으로" data-testid="back-home">
                <span aria-hidden="true">←</span> 홈
              </button>
              <h1>{TITLES[view]}</h1>
            </header>
          )}
          {view === 'recommend' && <RecommendView coach={coach} busy={starting} onStart={() => start('today')} onPrinciples={() => setView('principles')} />}
          {view === 'forecast' && <ForecastView coach={coach} insight={insight} onPlan={() => props.onPlan(cert, certName ?? cert)} onPrinciples={() => setView('principles')} />}
          {view === 'principles' && <Principles onForecast={coach.exam.projectedAvg != null ? () => setView('forecast') : null} />}
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
