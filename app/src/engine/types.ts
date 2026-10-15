/**
 * 학습 엔진 입력·출력 형식 (개발기준서 6장, 4단계).
 *
 * 엔진은 순수 함수다: (문항 목록, 풀이 원장, 설정, 현재 시각) → 예상 점수·주간 계획·세션.
 * DB·화면을 모르며, 현재 시각은 항상 인자(now)로 받는다(9.3). DB에서 입력을 만드는 일은 `load.ts`.
 */

/** 엔진이 보는 문항 한 개. 팩의 문항 메타데이터에서 필요한 것만 */
export interface EngineQuestion {
  qid: string;
  packId: string;
  /** 시행일(YYYY-MM-DD). 현행 과목 판정(가장 최근 회차)과 정렬에 쓴다 */
  examDate: string;
  /** 팩에 적힌 과목명(전처리 단계에서 출제기준 프로필로 정리된 이름 — ADR 005) */
  subjectName: string;
  /** 문항 텍스트(정답 표시 제거본). 동일 문항 판정에 쓴다 */
  text: string;
  /** 6단계 유사 문항 군집. 아직 없으면 null */
  clusterId: string | null;
}

/** 풀이 원장의 한 줄(AttemptRow에서 필요한 것만). chosen 0 = 모름 */
export interface EngineAttempt {
  qid: string;
  ts: number;
  correct: boolean;
  chosen: number;
  unsure: boolean;
  elapsedMs: number;
}

export interface PassRule {
  subjectMin: number; // 과락선(기본 40)
  avgMin: number; // 평균 합격선(기본 60)
}

/** 계획 엔진 설정(설정 화면·첫 실행에서 입력, 5단계) */
export interface PlanSettings {
  /** 시험일 YYYY-MM-DD(기기 현지 날짜) */
  examDate: string;
  /** 하루 학습시간(분) */
  dailyMinutes: number;
  /** 주간 학습일(1~7) */
  studyDaysPerWeek: number;
  /**
   * 날짜별 학습시간(분) — 기본값(하루 학습시간 × 주간 학습일 비율) 대신 그날 쓸 시간. 0이면 쉬는 날.
   * 예: 시험 14일 전부터 하루 150분, 시험 전날 합격 기준 경고가 알려 준 필요 시간 300분(ADR 007). 키는 YYYY-MM-DD(기기 현지 날짜)
   */
  dayMinutes?: Record<string, number>;
  /** 안전여유 m(점). 기본 10 */
  safetyMargin: number;
  passRule: PassRule;
}

export const DEFAULT_PLAN_SETTINGS: Omit<PlanSettings, 'examDate'> = {
  dailyMinutes: 60,
  studyDaysPerWeek: 6,
  safetyMargin: 10,
  passRule: { subjectMin: 40, avgMin: 60 },
};
