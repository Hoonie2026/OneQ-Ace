/**
 * 모의고사 출제 규칙(ADR 004 5.2.3, 6.5).
 *
 * 종목의 전 회차에서 **현행 과목마다 실제 시험의 문항 수**(가장 최근 회차 기준)만큼 뽑는다.
 * 같은 내용(동일 문항)은 한 번만 나온다. 시간 = 문항당 1.5분(기사 필기 100문항 150분).
 *
 * 출제 방식은 시뮬레이션(engine.test.ts '모의고사 출제 방식')으로 정했다:
 * - 'frequency'(기본): 출제빈도 가중 무작위. 모의고사 점수의 기댓값이 예상 점수와 같다 → 실전 측정용
 * - 'random': 균등 무작위. 자주 나온 문항이 덜 나와 실전보다 낯선 문항 비중이 커진다
 * - 'weak': 약점 가중. 점수가 체계적으로 낮게 나와 실력 측정에 쓸 수 없다 → 약점 보강은 '오늘 학습'이 맡는다
 */
import type { Bank, Item } from './items';
import type { MemoryState } from './memory';
import { itemExamP } from './predict';
import { representativeQid } from './session';

export type MockStrategy = 'frequency' | 'random' | 'weak';

export interface MockExam {
  qids: string[];
  bySubject: { key: string; name: string; qids: string[] }[];
  minutes: number;
}

/** 시드가 있는 난수(같은 시드 = 같은 시험지, 시험 재현용) */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4_294_967_296;
  };
}

/** 가중치 비복원 추출(Efraimidis–Spirakis) */
function weightedSample<T>(xs: T[], w: (x: T) => number, n: number, rand: () => number): T[] {
  return xs
    .map((x) => ({ x, k: Math.pow(rand(), 1 / Math.max(1e-9, w(x))) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, n)
    .map((e) => e.x);
}

export function buildMock(bank: Bank, mem: MemoryState, opts: { seed: number; strategy?: MockStrategy; now?: number }): MockExam {
  const rand = rng(opts.seed);
  const strategy = opts.strategy ?? 'frequency';
  const now = opts.now ?? Date.now();
  const weight = (it: Item): number =>
    strategy === 'frequency' ? it.qids.length : strategy === 'weak' ? 1 - itemExamP(it, mem, now) + 0.05 : 1;
  const bySubject = bank.subjects
    .filter((s) => s.current && s.examCount > 0)
    .map((s) => {
      const pool = bank.items.filter((it) => it.subjectKey === s.key);
      const qids = weightedSample(pool, weight, s.examCount, rand).map(representativeQid);
      return { key: s.key, name: s.name, qids };
    });
  const qids = bySubject.flatMap((s) => s.qids);
  return { qids, bySubject, minutes: Math.round(qids.length * 1.5) };
}
