import { useEffect, useState } from 'react';
import { mockHistory, type MockRecord } from '../coach';

const VERDICT_TEXT = { pass: '합격선 통과', 'fail-subject': '과락', 'fail-average': '평균 미달' } as const;

/** 모의고사 탭: 시작 + 성적 이력(ADR 004 — 모의고사는 성적만 이력) */
export function MockPanel(props: {
  certCode: string;
  version: number;
  busy: boolean;
  questionCount: number;
  onStart: () => void;
  onOpen: (sessionId: string, finished: boolean) => void;
}) {
  const [list, setList] = useState<MockRecord[] | null>(null);
  useEffect(() => {
    mockHistory(props.certCode).then(setList);
  }, [props.certCode, props.version]);

  const open = list?.find((m) => !m.finished);
  const done = (list ?? []).filter((m) => m.finished);
  const minutes = Math.round(props.questionCount * 1.5);

  return (
    <section className="stack" data-testid="mock-panel">
      <div className="card">
        <h2>모의고사</h2>
        <p className="hint">
          보유 기출 전체에서 과목별 실제 문항 수만큼, 자주 나온 문항일수록 잘 뽑히게 출제합니다. 풀이 중에는 정답을 보여 주지 않고, 제출하거나 시간이 끝나면
          채점합니다. 시험시간 {Math.floor(minutes / 60)}시간{minutes % 60 ? ` ${minutes % 60}분` : ''}(문항당 1분 30초).
        </p>
        {open ? (
          <button className="btn btn-primary btn-block" onClick={() => props.onOpen(open.sessionId, false)} data-testid="mock-resume">
            진행 중인 모의고사 이어서 ({open.result.answered}/{open.result.total})
          </button>
        ) : (
          <button className="btn btn-primary btn-block" disabled={props.busy} onClick={props.onStart} data-testid="mock-start">
            모의고사 시작 ({props.questionCount}문항)
          </button>
        )}
      </div>

      {done.length > 0 && (
        <div className="card">
          <h2>모의고사 성적</h2>
          <table className="history" data-testid="mock-history">
            <thead>
              <tr>
                <th>날짜</th>
                <th>평균</th>
                <th>최저 과목</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              {done.map((m) => {
                const low = Math.min(...m.result.subjects.map((s) => s.score));
                return (
                  <tr key={m.sessionId} onClick={() => props.onOpen(m.sessionId, true)} className="clickable">
                    <td>{new Date(m.startedAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</td>
                    <td>{m.result.avgScore}점</td>
                    <td>{Number.isFinite(low) ? `${low}점` : '-'}</td>
                    <td>{m.result.verdict ? VERDICT_TEXT[m.result.verdict] : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
