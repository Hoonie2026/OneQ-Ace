import { EXTRA_SIZE, fmtMinutes, type Coach } from '../coach';
import { MIN_TIMING_OBS } from '../engine/memory';
import { DIAG_OBS, REVIEW_SHARE } from '../engine/session';

/** 초 → "1분 32초" */
export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? (s ? `${m}분 ${s}초` : `${m}분`) : `${s}초`;
}

/**
 * 시스템 추천 학습(ADR 011·014): 오늘 무엇을 왜 푸는지 먼저 보여 주고 [학습 시작].
 * v0.8.0(사용자 요청): 문항 수가 어떻게 정해졌는지, 복습·새 문항이 왜 그만큼인지, 어떤 원리인지를 화면에서 바로 확인
 * (자세한 설명은 접어 두어 화면이 복잡해지지 않게)
 */
export function RecommendView(props: { coach: Coach; busy: boolean; onStart: () => void }) {
  const { today } = props.coach;
  const timed = today.timingObs >= MIN_TIMING_OBS;
  const rows: { label: string; n: number; hint: string; tag: string }[] = [
    { label: '오늘 틀린·모름 문항 다시', n: today.relearn, hint: '틀린 직후 정답을 확인하고 한 번 더', tag: '오답 교정' },
    { label: '지난번 틀린·모름 문항', n: today.wrong, hint: '잊을 때쯤(기억률 90% 아래로 떨어질 날) 다시', tag: '간격 반복' },
    { label: '맞혔지만 다시 볼 문항', n: today.review, hint: '맞힌 문항은 간격을 점점 길게 — 오래 걸린 정답은 더 자주', tag: '간격 반복' },
    { label: '새 문항', n: today.fresh, hint: '과락 위험이 큰 과목에 많이, 다른 과목에도 조금씩 — 여러 회차에 나온 문항부터', tag: '약한 과목 먼저' },
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

        <div className="calc-box" data-testid="rec-count">
          <b>문항 수 계산</b>
          {today.extra ? (
            <p>오늘 목표 {today.target}문항을 다 풀어 {EXTRA_SIZE}문항씩 추가로 냅니다.</p>
          ) : (
            <p>
              오늘 계획 {fmtMinutes(today.minutes)} ÷ 문항당 {fmtSec(today.secPerQuestion)} = <b>{today.target}문항</b>
              {today.done > 0 && (
                <>
                  {' '}
                  − 오늘 푼 {today.done}문항 = <b>{Math.max(0, today.target - today.done)}문항</b>
                </>
              )}
            </p>
          )}
          <small className="muted">
            문항당 시간: {timed ? `내 풀이 ${today.timingObs}건의 중앙값(매번 다시 계산)` : `풀이가 ${MIN_TIMING_OBS}건 쌓일 때까지는 기본값 1분 30초`}
          </small>
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
                    <b>
                      {r.label} <span className="tag">{r.tag}</span>
                    </b>
                    <small className="muted">{r.hint}</small>
                  </div>
                  <span>{r.n}</span>
                </li>
              ))}
          </ul>
        )}

        {today.bySubject.length > 0 && (
          <table className="mini-table" data-testid="rec-subjects">
            <thead>
              <tr>
                <th>과목</th>
                <th>복습</th>
                <th>새 문항</th>
              </tr>
            </thead>
            <tbody>
              {today.bySubject.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{b.review}</td>
                  <td>{b.fresh}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <details className="why" data-testid="rec-why">
          <summary>왜 이렇게 구성했나요?</summary>
          <ul>
            <li>
              <b>복습은 최대 {Math.round(REVIEW_SHARE * 100)}%</b> — 틀린 문항이 쌓여도 새 문항을 계속 풀게 합니다. 복습할 문항이 적으면 그만큼 새 문항이 늘어납니다(매일 달라짐).
              가상 학습자 시험에서 40%·80%보다 60%일 때 합격률이 가장 높았습니다.
            </li>
            <li>
              <b>복습 날짜</b>는 문항마다 FSRS(간격 반복 알고리즘)가 "기억률이 90% 아래로 떨어질 날"로 계산합니다. 틀린 문항은 곧, 맞힌 문항은 점점 길게.
            </li>
            <li>
              <b>새 문항</b>은 과목마다 "합격에 보태는 정도"에 비례해 나눕니다 — 과락선에 가까운 과목이 가장 많이, 이미 안전한 과목은 조금. 한 과목에 하루 분량을
              다 주면 다른 과목을 잊어 무너졌습니다(가상 학습자 시험). 처음에는 모든 과목을 {DIAG_OBS}문항씩 번갈아 풀어 실력을 진단합니다. 같은 과목 안에서는 여러 회차에 나온 문항
              → 최근 회차 순입니다.
            </li>
            <li>
              <b>순서</b>: 복습 먼저, 새 문항 다음. 과목을 일부러 섞지는 않습니다 — 섞어 풀기의 효과는 비슷한 유형을 구별하는 문제에서는 확인됐지만 단어(어휘) 학습에서는 오히려
              나빴습니다(메타분석). 한 과목의 기출은 이미 여러 회차·단원이 섞여 있습니다.
            </li>
            <li>
              <b>다 풀면</b> 이 묶음에서 틀리거나 모른 문항만 그 자리에서 한 번 더 풉니다(정답 확인 뒤 바로 다시 — 오답 교정).
            </li>
          </ul>
        </details>

        <button className="btn btn-primary btn-block btn-big" disabled={props.busy || today.size === 0} onClick={props.onStart} data-testid="today-start">
          학습 시작 ({today.size}문항)
        </button>
      </div>
    </section>
  );
}
