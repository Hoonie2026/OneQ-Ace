/**
 * 날짜별 학습시간(ADR 007). 계획 가용량·부족 경고·합격 기준 경고가 모두 이 함수로 남은 시간을 센다.
 *
 * 날짜별 지정(`dayMinutes`)이 있으면 그 값, 없으면 하루 학습시간 × 주간 학습일 비율(주 6일이면 6/7).
 * 요일을 정해 두지 않고 비율로 나누는 것은 기존 계획(6.4)과 같다 — 사람마다 쉬는 요일이 달라서.
 */
import { addDays, formatDate, startOfDay } from './days';
import type { PlanSettings } from './types';

type MinuteSettings = Pick<PlanSettings, 'dailyMinutes' | 'studyDaysPerWeek' | 'dayMinutes'>;

/** 그날 학습시간(분). 기본 날은 비율을 곱한 기댓값(예: 60분 × 6/7) */
export function minutesOn(s: MinuteSettings, dayTs: number): number {
  const v = s.dayMinutes?.[formatDate(dayTs)];
  if (v != null && Number.isFinite(v)) return Math.max(0, v);
  return s.dailyMinutes * Math.min(1, s.studyDaysPerWeek / 7);
}

/** 그날 지정된 학습시간이 있는가(없으면 기본값) */
export function hasOverride(s: MinuteSettings, dayTs: number): boolean {
  const v = s.dayMinutes?.[formatDate(dayTs)];
  return v != null && Number.isFinite(v);
}

export interface StudyTime {
  /** 기간 안 학습시간 합(분) */
  minutes: number;
  /** 학습일 수(기본 날은 비율로 센 기댓값, 지정한 날은 0분 초과면 1) */
  days: number;
}

/** [from, to] 두 날짜(현지 자정, 둘 다 포함) 사이 학습시간 */
export function studyTime(s: MinuteSettings, fromDay: number, toDay: number): StudyTime {
  let minutes = 0;
  let days = 0;
  const ratio = Math.min(1, s.studyDaysPerWeek / 7);
  for (let d = startOfDay(fromDay); d <= toDay; d = addDays(d, 1)) {
    minutes += minutesOn(s, d);
    days += hasOverride(s, d) ? (minutesOn(s, d) > 0 ? 1 : 0) : ratio;
  }
  return { minutes, days };
}

/** 오늘 실제로 할 학습시간(분). 기본 날은 하루 학습시간 그대로(비율은 주 전체에서 쉬는 날로 나타난다) */
export function minutesToday(s: MinuteSettings, dayTs: number): number {
  return hasOverride(s, dayTs) ? minutesOn(s, dayTs) : s.dailyMinutes;
}
