import { useEffect, useState } from 'react';
import { examViews, fmtMinutes } from '../coach';
import { addDays, formatDate, parseDate, startOfDay } from '../engine/days';
import { DEFAULT_PLAN_SETTINGS, engineForecast, engineOutlook, loadEngine, loadPlanSettings, savePlanSettings, type EngineContext } from '../engine';
import { scoreTone } from './CoachCard';
import { BackButton } from './Icon';

const DAILY = [30, 45, 60, 90, 120, 150, 180, 240];

/**
 * 학습 계획(종목별): 시험일·하루 학습시간·주간 학습일·날짜별 학습시간(ADR 007).
 * 첫 실행에서 시험일을 정하면 홈에 D-day·예상 점수·오늘 학습이 나온다.
 */
export function PlanSetup(props: { certCode: string; certName: string; onBack: () => void; onSaved: (msg: string) => void }) {
  const today = formatDate(startOfDay(Date.now()));
  const [loaded, setLoaded] = useState(false);
  const [examDate, setExamDate] = useState('');
  const [daily, setDaily] = useState(DEFAULT_PLAN_SETTINGS.dailyMinutes);
  const [days, setDays] = useState(DEFAULT_PLAN_SETTINGS.studyDaysPerWeek);
  const [special, setSpecial] = useState<Record<string, number>>({});
  const [newDate, setNewDate] = useState(today);
  const [newMin, setNewMin] = useState(180);
  const [ctx, setCtx] = useState<EngineContext | null>(null);

  useEffect(() => {
    (async () => {
      setCtx(await loadEngine(props.certCode));
      const s = await loadPlanSettings(props.certCode);
      if (s) {
        setExamDate(s.examDate);
        setDaily(s.dailyMinutes);
        setDays(s.studyDaysPerWeek);
        // 지난 날짜는 보여 주지 않는다(저장할 때도 정리)
        setSpecial(Object.fromEntries(Object.entries(s.dayMinutes ?? {}).filter(([k]) => k >= today)));
      }
      setLoaded(true);
    })();
  }, [props.certCode]);

  const daysLeft = examDate ? Math.round((parseDate(examDate) - parseDate(today)) / 86_400_000) : null;
  const valid = !!examDate && daysLeft != null && daysLeft > 0;
  const specialList = Object.entries(special).filter(([k]) => !examDate || k < examDate).sort(([a], [b]) => (a < b ? -1 : 1));

  // 이 계획이면 시험일 예상 점수(저장 전 미리보기 — 실기기 v0.5.0: 계획을 바꿔도 예상 점수 변화가 안 보였다)
  // 날짜별 학습시간이 있으면 "없을 때"와 비교해 그 효과를 따로 보여 준다(실기기 v0.6.0: 시험 직전 집중 학습이 반영되는지 보이지 않았다)
  let preview: { avg: number | null; rounds: number; hours: number; rho: number; base: { avg: number | null; hours: number } | null } | null = null;
  if (ctx && valid) {
    const now = Date.now();
    const at = (dayMinutes: Record<string, number>) => {
      const settings = { ...DEFAULT_PLAN_SETTINGS, ...(ctx.settings ?? {}), examDate, dailyMinutes: daily, studyDaysPerWeek: days, dayMinutes };
      const c2 = { ...ctx, settings };
      const o = engineOutlook(c2, now);
      const v = examViews(c2, engineForecast(c2), o, now);
      return {
        avg: v.exam.projectedAvg,
        rounds: v.exam.rounds,
        hours: Math.round((o?.plannedMinutes ?? 0) / 6) / 10,
        rho: v.exam.rho,
      };
    };
    const cur = at(Object.fromEntries(specialList));
    preview = { ...cur, base: specialList.length ? at({}) : null };
  }

  const save = async () => {
    if (!valid) return;
    const dayMinutes = Object.fromEntries(specialList);
    await savePlanSettings(props.certCode, { examDate, dailyMinutes: daily, studyDaysPerWeek: days, dayMinutes });
    props.onSaved(`학습 계획을 저장했습니다 — 시험까지 ${daysLeft}일`);
    props.onBack();
  };

  const addSpecial = () => {
    if (!newDate || newDate < today || (examDate && newDate >= examDate)) return;
    setSpecial((m) => ({ ...m, [newDate]: Math.max(0, Math.min(960, Math.round(newMin))) }));
    setNewDate(formatDate(addDays(parseDate(newDate), 1)));
  };

  if (!loaded) return <div className="app" />;
  return (
    <div className="app">
      <header className="page-head">
        <BackButton label="홈" onClick={props.onBack} />
        <h1>학습 계획</h1>
      </header>

      <section className="card stack">
        <p className="muted">{props.certName}</p>
        <label className="field">
          <span>시험일</span>
          <input type="date" value={examDate} min={formatDate(addDays(parseDate(today), 1))} onChange={(e) => setExamDate(e.target.value)} data-testid="plan-exam-date" />
        </label>
        {daysLeft != null && <p className={`hint${valid ? '' : ' warn-text'}`}>{valid ? `시험까지 ${daysLeft}일 남았습니다` : '시험일은 내일 이후로 고르세요'}</p>}

        <label className="field">
          <span>하루 학습시간</span>
          <select value={daily} onChange={(e) => setDaily(Number(e.target.value))} data-testid="plan-daily">
            {[...new Set([...DAILY, daily])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {fmtMinutes(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>일주일에 공부하는 날</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n}일
              </option>
            ))}
          </select>
        </label>
        <p className="hint">문항당 1분 30초로 시작해, 풀어 보면 내 풀이 속도로 바뀝니다.</p>
      </section>

      <section className="card stack">
        <h2>날짜별 학습시간</h2>
        <p className="hint">평소와 다른 날만 적습니다. 더 공부할 날(휴가·주말 집중)은 길게, 못 하는 날은 0분.</p>
        {specialList.length > 0 && (
          <ul className="day-list">
            {specialList.map(([k, m]) => (
              <li key={k}>
                <span>
                  {new Date(parseDate(k)).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })}
                </span>
                <b>{m ? fmtMinutes(m) : '쉬는 날'}</b>
                <button
                  className="btn btn-small btn-ghost"
                  aria-label={`${k} 지우기`}
                  onClick={() =>
                    setSpecial((s) => {
                      const n = { ...s };
                      delete n[k];
                      return n;
                    })
                  }
                >
                  지우기
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="day-add">
          <input type="date" value={newDate} min={today} max={examDate ? formatDate(addDays(parseDate(examDate), -1)) : undefined} onChange={(e) => setNewDate(e.target.value)} aria-label="날짜" />
          <select value={newMin} onChange={(e) => setNewMin(Number(e.target.value))} aria-label="그날 학습시간">
            {[0, 30, 60, 90, 120, 180, 240, 300, 360, 480].map((m) => (
              <option key={m} value={m}>
                {m ? fmtMinutes(m) : '쉬는 날'}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={addSpecial}>
            추가
          </button>
        </div>
      </section>

      {preview?.avg != null && (
        <section className={`card plan-preview ${scoreTone(preview.avg)}`} data-testid="plan-preview">
          <p>
            이 계획이면 <b>시험일 예상 점수 {preview.avg}점</b>
          </p>
          <p className="hint">시험일까지 학습시간 합계 {preview.hours}시간</p>
          {preview.base?.avg != null && (
            <p className="hint" data-testid="plan-preview-special">
              날짜별 학습시간 반영: {preview.hours - preview.base.hours >= 0 ? '+' : ''}
              {Math.round((preview.hours - preview.base.hours) * 10) / 10}시간 → {preview.avg - preview.base.avg >= 0 ? '+' : ''}
              {Math.round((preview.avg - preview.base.avg) * 10) / 10}점 (없으면 {preview.base.avg}점)
            </p>
          )}
          {preview.rounds >= 5 && (
            <p className="hint">
              보유 기출 {preview.rounds}회차 기준: 실제 시험의 약 {Math.round(preview.rho * 100)}%가 이 기출(같은 문항·숫자만 바꾼 변형)에서 나온다고 보고 계산합니다.
            </p>
          )}
          {preview.rounds < 5 && (
            <p className="hint">
              보유 기출이 {preview.rounds}회차뿐이라 학습시간을 늘려도 예상 점수가 거의 오르지 않습니다(더 익힐 새 문항이 없음). 문제팩을 10회차 이상 넣으면 시간에 따라 달라집니다.
            </p>
          )}
        </section>
      )}

      <section className="actions">
        <button className="btn btn-primary btn-block" disabled={!valid} onClick={save} data-testid="plan-save">
          저장
        </button>
      </section>
    </div>
  );
}
