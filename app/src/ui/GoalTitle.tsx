import { useEffect, useRef, useState } from 'react';
import { EXTRA_SIZE, fmtMinutes, type TodayPlan } from '../coach';
import { MIN_TIMING_OBS } from '../engine/memory';
import { Icon } from './Icon';

/** 초 → "1분 32초" */
export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? (s ? `${m}분 ${s}초` : `${m}분`) : `${s}초`;
}

/** 오늘 목표 제목 글(v0.11.3·v0.11.4): 시스템 추천·과목별 학습이 같은 숫자 */
export function goalTitle(today: TodayPlan): string {
  if (today.extra) return today.left < EXTRA_SIZE ? `추가 학습 ${EXTRA_SIZE}문항 중 ${today.left}문항 남음` : `추가 학습 ${EXTRA_SIZE}문항`;
  return today.done > 0 ? `오늘 목표 ${today.target}문항 중 ${today.left}문항 남음` : `오늘 목표 ${today.target}문항`;
}

/**
 * 오늘 목표 제목 + 문항 수 계산 안내창(v0.11.3 시스템 추천 → v0.11.4 과목별 학습에도).
 * PC는 제목에 마우스를 올리면, 폰·태블릿·펜은 제목을 누르면 열리고, 바깥을 누르거나 Esc로 닫힌다
 */
export function GoalTitle(props: { today: TodayPlan }) {
  const { today } = props;
  const timed = today.timingObs >= MIN_TIMING_OBS;
  const title = goalTitle(today);
  const [tip, setTip] = useState(false);
  const pointer = useRef('mouse');
  useEffect(() => {
    if (!tip) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('[data-tip="rec-count"]')) setTip(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setTip(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [tip]);
  return (
    <div
      className="rec-title"
      data-tip="rec-count"
      role="button"
      tabIndex={0}
      aria-expanded={tip}
      aria-label={`${title} — 문항 수 계산 보기`}
      data-testid="rec-title"
      onPointerDown={(e) => (pointer.current = e.pointerType)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setTip(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setTip(false)}
      onClick={() => setTip((t) => (pointer.current === 'mouse' ? true : !t))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setTip((t) => !t);
        }
      }}
    >
      <h2>
        {title} <Icon name="info" size={18} className="rec-info" />
      </h2>
      {tip && (
        <div className="calc-box rec-tip" role="tooltip" data-testid="rec-count">
          <b>문항 수 계산</b>
          {today.extra && <p>오늘 목표 {today.target}문항을 다 풀어 {EXTRA_SIZE}문항씩 추가로 냅니다.</p>}
          <p>목표 문항 수는 "홈 &gt; 학습계획 설정"의 하루 학습시간 설정값에 따라 자동 계산</p>
          <p>
            오늘 계획 {fmtMinutes(today.minutes)} / 문항당 {fmtSec(today.secPerQuestion)} = <b>{today.target}문항</b>
          </p>
          <p>시스템 추천 학습과 과목별 학습에서 푼 문항을 합해서 셉니다(오늘 푼 {today.done}문항).</p>
          <p className="muted">
            문항당 시간은 풀이가 {MIN_TIMING_OBS}건 이상 쌓일 때부터 통계에 따라 자동 재설정
            {timed ? ` (지금: 내 풀이 ${today.timingObs}건의 중앙값)` : ' (지금: 기본값 1분 30초)'}
          </p>
        </div>
      )}
    </div>
  );
}
