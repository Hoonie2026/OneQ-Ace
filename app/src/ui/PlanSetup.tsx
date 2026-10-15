import { useEffect, useState } from 'react';
import { fmtMinutes } from '../coach';
import { addDays, formatDate, parseDate, startOfDay } from '../engine/days';
import { DEFAULT_PLAN_SETTINGS, loadPlanSettings, savePlanSettings } from '../engine';

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

  useEffect(() => {
    (async () => {
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
        <button className="icon-btn" onClick={props.onBack} aria-label="뒤로">
          ‹
        </button>
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

      <section className="actions">
        <button className="btn btn-primary btn-block" disabled={!valid} onClick={save} data-testid="plan-save">
          저장
        </button>
      </section>
    </div>
  );
}
