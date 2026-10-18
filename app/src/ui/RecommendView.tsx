import { fmtMinutes, type Coach } from '../coach';
import { REVIEW_SHARE } from '../engine/session';

/**
 * 시스템 추천 학습(ADR 011): 오늘 무엇을 왜 푸는지 먼저 보여 주고 [학습 시작].
 * 구성 규칙: 복습(오늘 틀린 것 → 지난번 틀린·모름 → 맞혔지만 다시 볼 때 된 것)은 최대 60%, 나머지는 새 문항.
 */
export function RecommendView(props: { coach: Coach; busy: boolean; onStart: () => void }) {
  const { today } = props.coach;
  const rows: { label: string; n: number; hint: string }[] = [
    { label: '오늘 틀린·모름 문항 다시', n: today.relearn, hint: '오늘 틀린 것을 한 번 더' },
    { label: '지난번 틀린·모름 문항', n: today.wrong, hint: '잊을 때쯤 다시 — 오래 밀린 것부터' },
    { label: '맞혔지만 다시 볼 문항', n: today.review, hint: '찍어서 맞혔을 수도 있으니 드물게 다시(헷갈림 표시·오래 걸린 정답은 더 자주)' },
    { label: '새 문항', n: today.fresh, hint: '여러 회차에 자주 나온 문항부터' },
  ];
  return (
    <section className="stack" data-testid="recommend">
      <div className="card">
        <div className="today-head">
          <h2>오늘 추천 {today.size}문항</h2>
          <span className="muted">
            {today.extra ? '오늘 목표 완료 · 추가 학습' : `오늘 목표 ${fmtMinutes(today.minutes)} · ${today.target}문항 중 남은 분량`}
          </span>
        </div>
        {today.size === 0 ? (
          <p className="today-what">오늘 낼 문항을 모두 풀었습니다. 내일 복습이 준비됩니다.</p>
        ) : (
          <ul className="rec-rows" data-testid="today-what">
            {rows
              .filter((r) => r.n > 0)
              .map((r) => (
                <li key={r.label}>
                  <div>
                    <b>{r.label}</b>
                    <small className="muted">{r.hint}</small>
                  </div>
                  <span>{r.n}</span>
                </li>
              ))}
          </ul>
        )}
        {today.bySubject.length > 0 && (
          <p className="hint">
            과목: {today.bySubject.map((b) => `${b.name} ${b.review + b.fresh}`).join(' · ')}
          </p>
        )}
        <p className="hint">
          복습은 한 번에 최대 {Math.round(REVIEW_SHARE * 100)}%까지만 냅니다 — 틀린 문항이 쌓여도 새 문항을 계속 풀 수 있게. 다 풀면 그 자리에서 틀린 문항을 한 번 더 냅니다.
        </p>
        <button className="btn btn-primary btn-block btn-big" disabled={props.busy || today.size === 0} onClick={props.onStart} data-testid="today-start">
          학습 시작 ({today.size}문항)
        </button>
      </div>
    </section>
  );
}
