import { beforeEach, describe, expect, it } from 'vitest';
import { clearPick, interruptedPick, isSlow, markPickStart, progressRatio, SLOW_FILE_MS } from './importFlow';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
      },
    },
  });
});

describe('v0.10.7 문제팩 가져오기 진행·중단 안내', () => {
  it('선택기를 열고 닫으면 걸린 시간을 돌려주고 표시를 지운다', () => {
    markPickStart(1_000);
    expect(clearPick(31_000)).toBe(30_000);
    expect(clearPick(32_000)).toBeNull();
  });

  it('선택기를 연 채로 다시 시작되면 한 번만 "중단됨" — 오래된 표시는 무시', () => {
    markPickStart(0);
    expect(interruptedPick(60_000)).toBe(true);
    expect(interruptedPick(61_000)).toBe(false);
    markPickStart(0);
    expect(interruptedPick(60 * 60_000)).toBe(false);
  });

  it('진행 막대는 끝난 파일 + 지금 파일의 단계만큼, 끝나면 100%', () => {
    expect(progressRatio({ total: 4, done: 0, phase: 'read' })).toBeCloseTo(0.025);
    expect(progressRatio({ total: 4, done: 2, phase: 'save' })).toBeCloseTo((2 + 0.7) / 4);
    expect(progressRatio({ total: 4, done: 4, phase: 'save' })).toBe(1);
    expect(progressRatio({ total: 0, done: 0, phase: 'read' })).toBe(0);
  });

  it('한 파일이 20초를 넘으면 느림', () => {
    expect(isSlow({ fileStartedAt: 0 }, SLOW_FILE_MS - 1)).toBe(false);
    expect(isSlow({ fileStartedAt: 0 }, SLOW_FILE_MS)).toBe(true);
  });

  it('저장소를 못 쓰는 환경에서도 멈추지 않는다', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    expect(() => markPickStart()).not.toThrow();
    expect(interruptedPick()).toBe(false);
  });
});

describe('v0.10.8 결과 요약', () => {
  const fmt = (n: number) => `${n}B`;
  const mk = (k: number) => ({ cert: '건설안전기사', label: `${2011 + k}년 1회`, date: `${2011 + k}-03-01`, questions: 120, bytes: 10 });
  it('6개 이하는 한 줄씩', async () => {
    const { summarizeImported } = await import('./importFlow');
    expect(summarizeImported([mk(0), mk(1)], fmt)).toEqual(['2011년 1회 120문항 (10B)', '2012년 1회 120문항 (10B)']);
  });
  it('많으면 종목별 한 줄(첫·끝 회차, 문항·용량 합)', async () => {
    const { summarizeImported } = await import('./importFlow');
    const list = Array.from({ length: 35 }, (_, k) => mk(34 - k));
    expect(summarizeImported(list, fmt)).toEqual(['건설안전기사 35개 회차 · 2011년 1회 ~ 2045년 1회 · 4,200문항 · 350B']);
  });
});
