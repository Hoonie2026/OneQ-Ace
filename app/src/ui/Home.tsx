import { useEffect, useState } from 'react';
import { loadCoach, startMock, startSubject, type Coach } from '../coach';
import { db, describeError, getSetting, isStandalone, setSetting, SETTING, type PackRow } from '../db';
import { examLabel, type Target } from '../study';
import { CoachCard } from './CoachCard';
import { MockPanel } from './MockPanel';
import { PackPicker } from './PackPicker';
import { SubjectList } from './SubjectList';

type Tab = 'subjects' | 'mock';

interface Cert {
  code: string;
  name: string;
  packs: number;
}

interface PackLine {
  pack: PackRow;
  seen: number;
}

/**
 * 홈(ADR 008): 종목 → 대시보드(현재 → 시험일 예상, 합격 가능성) → [과목별 | 모의고사]. 회차별 풀이는 없앴고,
 * 문제팩은 아래 목록에서 가져오기·정보·삭제만 한다(회차별 기록은 원장에 그대로 남아 엔진이 쓴다).
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
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const [packs, setPacks] = useState<PackLine[] | null>(null);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [cert, setCert] = useState<string | null>(null);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [tab, setTab] = useState<Tab>('subjects');
  const [starting, setStarting] = useState(false);

  const loadCert = async (code: string | null, all: PackRow[]) => {
    const mine = all
      .filter((p) => p.manifest.cert.code === code)
      .sort((a, b) => b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round);
    const lines: PackLine[] = [];
    for (const p of mine) {
      const qids = new Set(await db.attempts.where('qid').startsWith(`${p.packId}-`).keys());
      lines.push({ pack: p, seen: qids.size });
    }
    setPacks(lines);
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
  const start = async (kind: 'subject' | 'mock', subjectKey?: string) => {
    if (!cert || starting) return;
    setStarting(true);
    try {
      const t = kind === 'subject' ? await startSubject(cert, subjectKey!) : await startMock(cert);
      if (t) props.onSolve(t);
      else props.toast(kind === 'subject' ? '오늘 이 과목에서 낼 문항이 없습니다. 다른 과목을 고르세요' : '모의고사를 만들 문항이 없습니다');
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
          <CoachCard
            coach={coach}
            certCode={cert}
            onPlan={() => props.onPlan(cert, certName ?? cert)}
            onResume={(sessionId) => props.onSolve({ kind: 'set', sessionId })}
            onChanged={props.onChanged}
            toast={props.toast}
          />

          <nav className="tabs" role="tablist" aria-label="학습 방법">
            <button role="tab" aria-selected={tab === 'subjects'} className={`tab${tab === 'subjects' ? ' on' : ''}`} onClick={() => setTab('subjects')} data-testid="tab-subjects">
              과목별
            </button>
            <button role="tab" aria-selected={tab === 'mock'} className={`tab${tab === 'mock' ? ' on' : ''}`} onClick={() => setTab('mock')} data-testid="tab-mock">
              모의고사
            </button>
          </nav>

          {tab === 'subjects' && <SubjectList coach={coach} busy={starting} onStudy={(k) => start('subject', k)} />}
          {tab === 'mock' && (
            <MockPanel
              certCode={cert}
              version={props.version}
              busy={starting}
              questionCount={mockCount}
              onStart={() => start('mock')}
              onOpen={(sessionId, finished) => (finished ? props.onResult({ kind: 'set', sessionId }) : props.onSolve({ kind: 'set', sessionId }))}
            />
          )}

          <section className="packs-section">
            <div className="section-head">
              <h2>문제팩 {packs.length}회차</h2>
              <PackPicker busy={props.busy} onFiles={props.onImport} small />
            </div>
            <ul className="pack-lines">
              {packs.map(({ pack, seen }) => (
                <li key={pack.packId}>
                  <button className="pack-line" onClick={() => props.onPack(pack.packId)} data-testid={`pack-${pack.packId}`}>
                    <span>{examLabel(pack.manifest)}</span>
                    <small className="muted" data-testid="pack-seen">
                      풀어 본 문항 {seen}/{pack.manifest.questionCount}
                    </small>
                    <span className="muted" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <p className="foot">서버 없음 · 데이터 수집 없음 · 모든 기록은 이 기기에만 저장됩니다</p>
    </div>
  );
}
