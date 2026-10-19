import { DIAG_OBS, REVIEW_SHARE } from '../engine/session';
import { TARGET_RETENTION } from '../engine/memory';

/** 가상 학습자 시험(npm run gate) 결과 요약 — ADR 014·docs/engine-gate.md. 게이트를 다시 돌리면 함께 고친다 */
export const GATE_SUMMARY = {
  /** 위기 대응형 9개 시나리오 × 3번, 같은 날짜별 학습시간(2026-10-19 게이트) */
  appPass: 0.75,
  sequentialPass: 0.4,
  enginePass: 0.51,
  /** 시험 전날 예상 평균과 실제의 차이(점): 망각형 60일을 뺀 24번은 모두 이 안 */
  typicalError: 4,
  worstError: 8,
};

interface Card {
  icon: string;
  title: string;
  what: string;
  evidence: React.ReactNode;
  app: React.ReactNode;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const CARDS: Card[] = [
  {
    icon: '✍',
    title: '읽지 말고 풀어라 — 인출 연습(시험 효과)',
    what: '머릿속에서 답을 꺼내 보는 연습이 다시 읽기보다 훨씬 오래 남습니다.',
    evidence: (
      <>
        글을 공부한 뒤 1주일이 지나자, 다시 읽기만 한 집단은 40%, 시험을 반복한 집단은 61%를 기억했습니다[1]. 10가지 학습법을 검토한 연구에서 효과가 "높음"으로 평가된 것은
        <b> 연습 시험</b>과 <b>분산 학습</b> 두 가지뿐이었고, 다시 읽기·밑줄 긋기는 "낮음"이었습니다[2].
      </>
    ),
    app: '모든 학습이 기출 풀이입니다. 보기를 스스로 고른 뒤 정답을 확인합니다. 모르면 찍지 말고 "모름" — 찍어서 맞힌 것을 아는 것으로 착각하지 않게 합니다.',
  },
  {
    icon: '↻',
    title: '틀리면 바로 확인하고 한 번 더 — 피드백',
    what: '객관식 시험은 오답 보기를 정답으로 잘못 기억하게 만들 수 있는데, 정답을 바로 확인하면 이 부작용이 줄고 시험 효과는 커집니다[3].',
    evidence: <>객관식 시험 뒤 정답 피드백을 준 집단이 더 많이 기억했고, 오답 보기를 답으로 적는 실수가 줄었습니다[3].</>,
    app: '풀 때마다 바로 정답을 보여 주고, 한 묶음이 끝나면 그 묶음에서 틀리거나 모른 문항만 그 자리에서 다시 풉니다.',
  },
  {
    icon: '📉',
    title: '잊을 때쯤 다시 — 망각 곡선과 간격 반복',
    what: '사람은 배운 것을 처음에 빠르게, 그다음엔 천천히 잊습니다. 몰아서 하는 것보다 간격을 두고 나눠 복습할 때 훨씬 오래 기억합니다.',
    evidence: (
      <>
        에빙하우스(1885)의 망각 곡선은 130년 뒤 다시 실험해도 거의 그대로 나왔습니다[4]. 184편의 논문, 317개 실험을 모은 메타분석에서 나눠서 공부(분산 학습)한 쪽이 몰아서 공부한
        쪽보다 꾸준히 더 오래 기억했고, 기억해야 할 기간이 길수록 복습 간격도 길어야 했습니다[5].
      </>
    ),
    app: `문항마다 "기억률이 ${pct(TARGET_RETENTION)} 아래로 떨어질 날"을 계산해 그날 복습으로 냅니다. 틀린 문항은 곧, 맞힌 문항은 점점 길게.`,
  },
  {
    icon: '⚙',
    title: 'FSRS — 문항마다 복습 날짜를 계산하는 알고리즘',
    what: '간격 반복 앱 Anki가 2023년 버전(23.10)부터 기본 탑재한 공개 알고리즘입니다. 기존 방식(SM-2)보다 언제 잊을지를 더 정확히 예측합니다.',
    evidence: (
      <>
        학습 앱의 실제 복습 기록으로 만든 기억 모형에서 출발했고(KDD 2022 논문)[6], 수많은 Anki 사용자 기록으로 다른 알고리즘과 예측 정확도를 비교하는 공개 벤치마크가
        있습니다[7].
      </>
    ),
    app: (
      <>
        공식 구현(ts-fsrs)을 그대로 씁니다. 문항마다 <b>안정도</b>(기억이 {pct(TARGET_RETENTION)}로 떨어지기까지 날 수)와 <b>난이도</b>를 풀이 기록으로 갱신하고, 복습 풀이가
        30건 쌓이면 내 기록에 맞춰 망각 속도를 보정합니다.
      </>
    ),
  },
  {
    icon: '⚖',
    title: '약한 과목 먼저 — 과락 막기',
    what: '과목 하나라도 40점 미만이면 평균이 높아도 불합격입니다. 같은 시간이면 가장 낮은 과목을 올리는 것이 합격 가능성을 가장 많이 올립니다.',
    evidence: <>합격 가능성을 과목별 점수로 계산해 보면, 과락선에 가까운 과목의 1점이 이미 안전한 과목의 1점보다 몇 배 값집니다(이 앱의 계산 — 아래 검증 참고).</>,
    app: `새 문항을 과목마다 합격 가능성에 보태는 정도에 비례해 나눕니다 — 과락선에 가까운 과목이 가장 많이, 안전한 과목도 잊지 않을 만큼 조금씩. 처음에는 과목마다 ${DIAG_OBS}문항씩 번갈아 풀어 실력을 진단합니다(진단이 끝나야 예상 점수가 나옵니다).`,
  },
  {
    icon: '📚',
    title: '기출 중심 — 시험은 기출에서 많이 나온다',
    what: '같은 문항이 몇 년 뒤 다시 나오고, 숫자·표현만 바꾼 변형도 많습니다.',
    evidence: (
      <>
        측량 필기 기출 34회차를 서로 대조해 쟀습니다: 앞 회차를 30회차 갖고 있으면 다음 시험의 약 43%가 같은 문항, 약 24%가 변형이었습니다. 같은 문항은 바로 앞 회차보다 3년
        이상 지난 회차에서 다시 나오는 경우가 많아, 회차를 많이 넣을수록 유리합니다(이 앱의 측정).
      </>
    ),
    app: '여러 회차에 나온 문항부터 냅니다. 같은 문항은 하나로 묶어 한 번 익히면 모든 회차에 반영합니다. 기출을 익히면 처음 보는 문항도 더 맞힌다는 연구(전이)[8]도 예상 점수에 넣었습니다.',
  },
  {
    icon: '🔀',
    title: '섞어 풀기는? — 솔직한 답',
    what: '여러 유형을 섞어 푸는 교차 학습은 평균적으로 효과가 있지만, 공부하는 내용에 따라 다릅니다.',
    evidence: (
      <>
        메타분석에서 그림·화풍 구별에서는 효과가 컸고 수학에서는 중간이었지만, 단어(어휘) 학습에서는 오히려 몰아서 공부하는 쪽이 나았습니다[9].
      </>
    ),
    app: '그래서 과목을 일부러 섞지 않습니다. 복습은 여러 과목이 섞여 나오고, 한 과목의 기출은 이미 여러 회차·단원이 섞여 있습니다.',
  },
];

const REFS: { n: number; text: string; url: string }[] = [
  { n: 1, text: 'Roediger & Karpicke (2006). Test-enhanced learning. Psychological Science 17(3).', url: 'https://doi.org/10.1111/j.1467-9280.2006.01693.x' },
  { n: 2, text: 'Dunlosky 외 (2013). Improving students’ learning with effective learning techniques. Psychological Science in the Public Interest 14(1).', url: 'https://doi.org/10.1177/1529100612453266' },
  { n: 3, text: 'Butler & Roediger (2008). Feedback enhances the positive effects and reduces the negative effects of multiple-choice testing. Memory & Cognition 36(3).', url: 'https://doi.org/10.3758/MC.36.3.604' },
  { n: 4, text: 'Murre & Dros (2015). Replication and analysis of Ebbinghaus’ forgetting curve. PLOS ONE 10(7).', url: 'https://doi.org/10.1371/journal.pone.0120644' },
  { n: 5, text: 'Cepeda 외 (2006). Distributed practice in verbal recall tasks: A review and quantitative synthesis. Psychological Bulletin 132(3).', url: 'https://doi.org/10.1037/0033-2909.132.3.354' },
  { n: 6, text: 'Ye, Su & Cao (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. KDD 2022.', url: 'https://github.com/open-spaced-repetition' },
  { n: 7, text: 'open-spaced-repetition: FSRS 알고리즘·벤치마크(공개 저장소).', url: 'https://github.com/open-spaced-repetition' },
  { n: 8, text: 'Pan & Rickard (2018). Transfer of test-enhanced learning: Meta-analytic review and synthesis. Psychological Bulletin 144(7).', url: 'https://doi.org/10.1037/bul0000151' },
  { n: 9, text: 'Brunmair & Richter (2019). Similarity matters: A meta-analysis of interleaved learning and its moderators. Psychological Bulletin 145(11).', url: 'https://doi.org/10.1037/bul0000209' },
];

/**
 * 학습 원리(ADR 014 — 사용자 요청: 망각 곡선·간격 반복 등 검증된 방법을 근거와 함께 보여 줘 앱의 알고리즘을 믿고 따를 수 있게).
 * 홈 맨 아래 "학습 원리" 단추로 연다. 원리마다 ① 무엇 ② 근거(연구) ③ 앱에서는 — 그리고 이 앱을 어떻게 검증했는지와 한계
 */
export function Principles(props: { onForecast: (() => void) | null }) {
  const g = GATE_SUMMARY;
  return (
    <section className="stack principles" data-testid="principles">
      <div className="card">
        <h2>이 앱은 이렇게 공부시킵니다</h2>
        <p className="hint">학습 연구에서 효과가 반복해서 확인된 방법만 골라, 기출 문제 풀이에 맞게 묶었습니다. 각 원리 아래에 근거 연구와 앱이 실제로 하는 일을 적었습니다.</p>
        <ol className="flow">
          <li>기출을 풀고(인출 연습) 바로 정답 확인</li>
          <li>틀린·모른 문항은 그 자리에서 한 번 더</li>
          <li>문항마다 잊을 때쯤 복습(FSRS) — 하루 분량의 최대 {pct(REVIEW_SHARE)}</li>
          <li>나머지는 새 문항 — 과락 위험이 큰 과목에 많이</li>
          <li>매일 기록으로 시험일 점수와 합격 가능성을 다시 계산</li>
        </ol>
      </div>

      {CARDS.map((c) => (
        <article className="card principle" key={c.title}>
          <h3>
            <span aria-hidden="true">{c.icon}</span> {c.title}
          </h3>
          <p>{c.what}</p>
          <p className="ev">
            <span className="tag">근거</span> {c.evidence}
          </p>
          <p className="ev">
            <span className="tag app">앱에서는</span> {c.app}
          </p>
        </article>
      ))}

      <article className="card principle" data-testid="principle-forecast">
        <h3>
          <span aria-hidden="true">🎯</span> 시험일 예상 점수와 합격 가능성
        </h3>
        <p>
          ① 실제 시험 문항을 "보유 기출과 같은 문항 / 변형 / 처음 보는 문항"으로 나누고 ② 문항마다 시험일 아침의 기억률(FSRS)로 맞힐 확률을 계산한 뒤 ③ 남은 학습시간으로 더 익힐
          문항을 더하고 ④ 과목당 20문항 시험의 운과 예상 오차를 넣어 "모든 과목 40점 이상 + 평균 60점 이상"일 확률을 냅니다.
        </p>
        <p className="ev">
          <span className="tag">경고</span> 계획대로 해도, 또는 최근 실제 학습량 그대로면 합격이 어렵거나 아슬아슬할 때 홈에 "학습 점검" 카드가 뜨고, 합격에 필요한 하루 학습시간을 알려
          줍니다.
        </p>
        {props.onForecast && (
          <button className="link-btn" onClick={props.onForecast}>
            내 숫자로 계산 과정 보기 ›
          </button>
        )}
      </article>

      <article className="card principle" data-testid="principle-gate">
        <h3>
          <span aria-hidden="true">🧪</span> 이 방법은 어떻게 검증했나
        </h3>
        <p>
          실력과 망각 속도가 다른 가상 학습자 3명(고른 실력 / 한 과목만 약함 / 빨리 잊음)을 시험 60·30·14일 전에서 출발시켜, 이 앱의 추천대로 공부했을 때와 <b>같은 시간 동안 회차 순서대로
          풀고 틀린 것만 다시 푼 경우</b>를 비교했습니다. 가상 학습자의 기억은 일부러 앱의 모형(FSRS)과 다른 방식으로 잊게 해, 모형이 틀려도 잘 되는지 봤습니다.
        </p>
        <ul className="plain">
          <li>
            합격 가능성(시나리오 평균): 앱 추천 <b>{pct(g.appPass)}</b> · 회차 순서대로 {pct(g.sequentialPass)} · 주간 계획 엔진(4단계 방식) {pct(g.enginePass)}
          </li>
          <li>
            시험 전날 예상 평균과 실제 점수 차이: 27번 중 24번이 ±{g.typicalError}점 안. 빨리 잊는 학습자가 60일 공부한 경우만 약 {g.worstError}점 높게 예상했습니다(모형보다
            훨씬 빨리 잊는 사람은 예상보다 낮게 나올 수 있다는 뜻 — 복습 문제를 자주 틀린다면 학습시간을 넉넉히 잡으세요)
          </li>
          <li>복습 비중 40%·60%·80%를 비교해 합격 가능성이 가장 높았던 60%를 씁니다.</li>
          <li>새 문항을 한 과목에 몰아주는 것보다 과목별 비중대로 나눌 때 빨리 잊는 학습자의 과락(37점)이 사라졌습니다.</li>
        </ul>
      </article>

      <article className="card principle">
        <h3>
          <span aria-hidden="true">⚠</span> 한계
        </h3>
        <ul className="plain">
          <li>연구 결과는 많은 사람의 평균 효과입니다. 사람마다 차이가 있어, 앱은 내 풀이 기록으로 계속 다시 계산합니다.</li>
          <li>예상 점수는 모형의 어림이고 합격을 보장하지 않습니다. 변형 문항 효과·전이 크기는 가정값이 들어 있습니다.</li>
          <li>가상 학습자 시험은 실제 사람 시험이 아닙니다. 실제 사용 기록이 쌓이면 다시 검증할 예정입니다.</li>
        </ul>
      </article>

      <div className="card refs">
        <h3>참고 문헌</h3>
        <ol>
          {REFS.map((r) => (
            <li key={r.n} value={r.n}>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.text}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
