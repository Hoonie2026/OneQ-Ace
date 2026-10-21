import { useEffect, useState } from 'react';
import { startSubject, startToday } from '../coach';
import { ensureWrongRun, loadSession, passHistory, restartPass, sessionResult, type PassRecord, type Result as R, type Target } from '../study';
import { askConfirm } from './Dialog';
import { BackButton } from './Icon';

const VERDICT: Record<NonNullable<R['verdict']>, { icon: string; text: string; cls: string }> = {
  pass: { icon: '✓', text: '합격선 통과', cls: 'ok' },
  'fail-subject': { icon: '✕', text: '과락 과목 있음', cls: 'bad' },
  'fail-average': { icon: '!', text: '평균 60점 미만', cls: 'warn' },
};

/** 성적. 풀이 중에도 지금까지 푼 문항으로 실시간 계산한다(ADR 003) */
export function Result(props: { target: Target; onHome: () => void; /** 위 ‹ — 풀이 중 성적 보기면 그 풀이로(v0.8.4), 아니면 홈 */ onBack?: () => void; onSolve: (t: Target) => void; toast: (m: string) => void }) {
  const [res, setRes] = useState<R | null>(null);
  const [rule, setRule] = useState({ min: 40, avg: 60 });
  const [packId, setPackId] = useState('');
  const [history, setHistory] = useState<PassRecord[]>([]);
  const [set, setSet] = useState<{ certCode: string; mode: string; finished: boolean } | null>(null);
  const [subjectKey, setSubjectKey] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await loadSession(props.target);
      if (!s) return props.onHome();
      setPackId(s.pack.packId);
      setRule({ min: s.pack.manifest.passRule.subjectMin, avg: s.pack.manifest.passRule.avgMin });
      if (s.target.kind === 'set') setSet({ certCode: s.run.certCode ?? s.pack.manifest.cert.code, mode: s.run.mode, finished: s.run.finishedAt != null });
      const r = await sessionResult(s);
      setRes(r);
      // 과목을 골라 시작한 학습이면 "이 과목 계속"
      if (s.target.kind === 'set' && s.run.subjectKey) setSubjectKey(s.run.subjectKey);
      if (props.target.kind === 'pass' && !props.target.subjectNo) setHistory(await passHistory(s.pack.packId));
    })();
  }, [JSON.stringify(props.target)]);

  if (!res) return <div className="app" />;
  const v = res.verdict ? VERDICT[res.verdict] : null;
  const wholePass = props.target.kind === 'pass' && !props.target.subjectNo;

  const retryWrong = async () => {
    const run = await ensureWrongRun(packId);
    if (run) props.onSolve({ kind: 'wrong', sessionId: run.sessionId });
  };
  /** 계속(ADR 010): 오늘 학습은 남은 계획량(다 했으면 15문항), 과목 학습은 그 과목 다음 15문항 */
  const next = async () => {
    if (!set) return;
    const t = subjectKey ? await startSubject(set.certCode, subjectKey) : await startToday(set.certCode);
    if (t) props.onSolve(t);
    else {
      props.toast('오늘 낼 문항을 모두 풀었습니다');
      props.onHome();
    }
  };
  const isMock = set?.mode === 'mock';
  const newPass = async () => {
    if (!(await askConfirm('이 회차를 처음부터 다시 풉니다(새 회독). 지금까지의 풀이 기록은 그대로 남습니다. 시작할까요?', { okText: '시작' }))) return;
    await restartPass(packId);
    props.onSolve({ kind: 'pass', packId });
  };

  return (
    <div className="app">
      <header className="page-head">
        <BackButton label={props.onBack ? '이전' : '홈'} onClick={props.onBack ?? props.onHome} testId="result-back" />
        <h1>{isMock ? '모의고사 결과' : res.complete ? '풀이 결과' : '지금까지 성적'}</h1>
      </header>
      <section className="card result-hero" data-testid="result">
        <p className="muted">
          {res.title} · {res.answered}/{res.total}문항 풀이
        </p>
        <div className="result-counts">
          <div className="rc ok">
            <b>{res.correct}</b>
            <span>맞힘</span>
          </div>
          <div className="rc bad">
            <b>{res.wrong}</b>
            <span>틀림</span>
          </div>
          <div className="rc unk">
            <b>{res.unknown}</b>
            <span>모름</span>
          </div>
        </div>
        {v && (
          <p className={`verdict ${v.cls}`}>
            <span aria-hidden="true">{v.icon}</span> {v.text}
          </p>
        )}
        {!res.complete && wholePass && <p className="hint">합격선 판정은 100문항을 다 풀면 보여 줍니다.</p>}
      </section>

      <section className="card">
        <div className="score-head">
          <h2>과목별 점수</h2>
          <p className={`avg-score${res.complete && res.avgScore < rule.avg ? ' bad' : ''}`} data-testid="avg-score">
            평균 <b>{res.avgScore}</b>점
          </p>
        </div>
        <ul className="bars">
          {res.subjects.map((s) => {
            const risk = res.complete && s.score < rule.min;
            return (
              <li key={s.no}>
                <div className="bar-label">
                  <span>
                    {s.no}. {s.name}
                  </span>
                  <b className={risk ? 'bad' : ''} data-testid={`subject-score-${s.no}`}>
                    {risk ? '과락 ' : ''}
                    {s.score}점
                  </b>
                </div>
                <div className="bar" role="img" aria-label={`${s.name} ${s.score}점`}>
                  <div className={`bar-fill${!res.complete ? ' partial' : s.score < rule.min ? ' bad' : s.score < rule.avg ? ' warn' : ''}`} style={{ width: `${s.score}%` }} />
                  <i className="bar-line" style={{ left: `${rule.min}%` }} />
                  <i className="bar-line avg" style={{ left: `${rule.avg}%` }} />
                </div>
                <small className="muted">
                  맞힘 {s.correct} / 푼 문항 {s.answered} / 전체 {s.total}
                  {s.rate !== null && s.answered < s.total ? ` · 푼 문항 정답률 ${s.rate}%` : ''}
                  {s.unknown ? ` · 모름 ${s.unknown}` : ''}
                </small>
              </li>
            );
          })}
        </ul>
        <p className="hint">
          점수 = 맞힌 문항 ÷ 과목 전체 문항 × 100{res.complete ? '' : '(안 푼 문항은 0점)'}. 평균 = 과목 점수의 평균. 세로선: 과락선 {rule.min} · 평균선{' '}
          {rule.avg}.
        </p>
      </section>

      {history.length > 0 && (
        <section className="card">
          <h2>이 회차 회독 이력</h2>
          <table className="history">
            <thead>
              <tr>
                <th>회독</th>
                <th>시작</th>
                <th>진도</th>
                <th>평균</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.sessionId}>
                  <td>{h.passNo}회독</td>
                  <td>{new Date(h.startedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</td>
                  <td>
                    {h.answered}/{h.total}
                  </td>
                  <td>{h.avgScore}점</td>
                  <td>{h.verdict ? VERDICT[h.verdict].text : h.finishedAt ? '중단' : '진행 중'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="actions">
        {!res.complete && !(set?.finished ?? false) && (
          <button className="btn btn-primary btn-block" onClick={() => props.onSolve(props.target)}>
            이어서 풀기 ({res.total - res.answered}문항 남음)
          </button>
        )}
        {set?.mode === 'today' && res.complete && (
          <>
            {/* v0.11(ADR 020): "오늘 학습 마치기" 없음 — 계속하거나 홈으로 */}
            <button className="btn btn-primary btn-block" onClick={next} data-testid="today-next">
              {subjectKey ? '이 과목 계속 학습하기' : '계속 학습하기'}
            </button>
            <button className="btn btn-block" onClick={props.onHome} data-testid="result-home">
              홈으로
            </button>
          </>
        )}
        {res.wrongQids.length > 0 && !set && (
          <button className={`btn btn-block${res.complete && !isMock ? ' btn-primary' : ''}`} onClick={retryWrong} data-testid="retry-wrong">
            틀린·모름 문항 다시 풀기
          </button>
        )}
        {res.complete && wholePass && (
          <button className="btn btn-block" onClick={newPass}>
            처음부터 다시 풀기(새 회독)
          </button>
        )}
        {!(set?.mode === 'today' && res.complete) && (
          <button className="btn btn-block" onClick={props.onHome}>
            홈으로
          </button>
        )}
      </section>
    </div>
  );
}
