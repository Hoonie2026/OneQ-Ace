import { useEffect, useState } from 'react';
import { fmtMinutes } from '../coach';
import { addDays, formatDate, parseDate, startOfDay } from '../engine/days';
import { DEFAULT_PLAN_SETTINGS, loadPlanSettings, savePlanSettings } from '../engine';
import { BackButton, Icon } from './Icon';

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
        <BackButton label="홈" onClick={props.onBack} />
        <h1>학습 계획</h1>
      </header>

      {/* v0.20.6(사용자 2026-11-18): 시험일 지정 · 학습 계획 설정 · 저장 — 예상 점수 미리보기 카드 없음 */}
      <section className="card plan-card" data-testid="plan-exam">
        <p className="plan-cert">{props.certName}</p>
        <label className="plan-label" htmlFor="plan-exam-date">
          시험일 지정
        </label>
        <div className="date-wrap">
          <input
            id="plan-exam-date"
            type="date"
            value={examDate}
            min={formatDate(addDays(parseDate(today), 1))}
            onChange={(e) => setExamDate(e.target.value)}
            data-testid="plan-exam-date"
          />
          <span className="date-ico" aria-hidden="true">
            <Icon name="calendar" size={24} />
          </span>
        </div>
        {daysLeft != null && <p className={`plan-left${valid ? '' : ' warn-text'}`}>{valid ? `시험까지 ${daysLeft}일 남았습니다` : '시험일은 내일 이후로 고르세요'}</p>}
      </section>

      <section className="card plan-card" data-testid="plan-study">
        <h2 className="plan-title">학습 계획 설정</h2>
        <div className="plan-row">
          <label className="plan-field">
            <span className="plan-label">1주당 학습일</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="plan-days">
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}일
                </option>
              ))}
            </select>
          </label>
          <label className="plan-field">
            <span className="plan-label">하루 학습시간</span>
            <select value={daily} onChange={(e) => setDaily(Number(e.target.value))} data-testid="plan-daily">
              {[...new Set([...DAILY, daily])].sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>
                  {fmtMinutes(m)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <span className="plan-label plan-sub">특정 날짜 학습시간 추가하기</span>
        <div className="day-add plan-day-add">
          <div className="date-wrap small">
            <input type="date" value={newDate} min={today} max={examDate ? formatDate(addDays(parseDate(examDate), -1)) : undefined} onChange={(e) => setNewDate(e.target.value)} aria-label="날짜" data-testid="plan-day-date" />
            <span className="date-ico" aria-hidden="true">
              <Icon name="calendar" size={20} />
            </span>
          </div>
          <select value={newMin} onChange={(e) => setNewMin(Number(e.target.value))} aria-label="그날 학습시간" data-testid="plan-day-min">
            {[0, 30, 60, 90, 120, 180, 240, 300, 360, 480].map((m) => (
              <option key={m} value={m}>
                {m ? fmtMinutes(m) : '쉬는 날'}
              </option>
            ))}
          </select>
          <button className="btn btn-small" onClick={addSpecial} data-testid="plan-day-add">
            추가
          </button>
        </div>
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
      </section>

      <section className="actions">
        <button className="btn btn-primary btn-block" disabled={!valid} onClick={save} data-testid="plan-save">
          저장
        </button>
      </section>
    </div>
  );
}
