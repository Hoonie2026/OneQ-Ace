/** 시험 구성 실측(v0.20): OCR 잡음이 있어도 같은 문항으로, 짧은 글·다른 문항은 처음 보는 문항으로, 보유 햇수로 곡선을 읽는다 */
import { describe, expect, it } from 'vitest';
import { buildBank } from './items';
import { baseShares, coveredYears, curveShares, examShares, SURVEY_ROUNDS_PER_YEAR } from './similar';
import type { EngineQuestion } from './types';

const Q = (year: number, no: number, text: string): EngineQuestion => ({ qid: `T-${year}-1-${no}`, packId: `T-${year}-1`, examDate: `${year}-03-05`, subjectName: '철도공학', text, clusterId: null });

describe('시험 구성(examShares)', () => {
  it('OCR로 글자가 조금 다른 같은 문항은 "같은 문항", 다른 문항·짧은 글은 "처음 보는 문항"', () => {
    const old = [
      Q(2016, 1, '92.레일의 부설시 레일길이가25m이고 레일온도가 20℃일 경우 레일 이음매 유간의 표준은? ①4mm ②5mm ③6mm ④7mm'),
      Q(2016, 2, '14.도상반력이 30kg/cm2,측정지점의 탄성침하가 6cm 일 때 도상계수와 이 노반에 대한 판정으로 옳은 것은?'),
      Q(2016, 3, '5. 다음 중 옳은 것은?'),
    ];
    const next = [
      Q(2022, 1, '96, 레일의(부실시 레일길이가25m이•고 레일온도가20℃일 경우 레일!e이음매 유간의 표준은? ① 가. 4mm나. 5mm다, 6mrn라. 7mm'),
      Q(2022, 2, '3. 클로소이드 곡선의 매개변수와 곡선길이로 반지름을 구하는 방법으로 옳은 것은?'),
      Q(2022, 3, '7. 다음 중 옳은 것은?'),
    ];
    const qs = [...old, ...next];
    const bank = buildBank(qs, [{ name: '철도공학', count: 3 }]);
    const text = new Map(qs.map((q) => [q.qid, q.text]));
    const sh = examShares(bank, (q) => text.get(q) ?? '');
    expect(sh.observed).toBe(3);
    // 실측: 같은 1, 변형 0, 처음 2 → 곡선(7년) 쪽으로 당겨짐
    const base = baseShares(bank.examDateOf.values());
    expect(sh.same).toBeCloseTo((1 + 300 * base.same) / 303, 5);
    expect(sh.variant).toBeCloseTo((0 + 300 * base.variant) / 303, 5);
  });

  it('곡선은 회차 수가 아니라 덮는 햇수로 읽는다(한 해 1회차 15년 = 측량 약 42회차 깊이)', () => {
    const dates = Array.from({ length: 15 }, (_, i) => `${2008 + i}-05-01`);
    expect(coveredYears(dates)).toBe(15);
    expect(baseShares(dates)).toEqual(curveShares(15 * SURVEY_ROUNDS_PER_YEAR));
    expect(baseShares(dates).same).toBeGreaterThan(0.4);
  });
});
