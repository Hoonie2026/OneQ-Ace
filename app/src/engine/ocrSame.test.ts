/** 스캔(OCR) 문제팩의 같은 문항 묶기(ADR 031) — 철도토목기사 스캔본 OCR 글 모양 그대로 */
import { describe, expect, it } from 'vitest';
import { buildBank, orderKey } from './items';
import { guardsPass, polarity, variantReason } from './ocrSame';
import { buildConcepts } from './similar';
import type { EngineQuestion } from './types';

let no = 0;
const Q = (year: number, text: string, ocr = true, round = 1): EngineQuestion => ({
  qid: `R-${year}-${round}-${String(++no).padStart(3, '0')}`,
  packId: `R-${year}-${round}`,
  examDate: `${year}-03-05`,
  subjectName: '선로',
  text,
  clusterId: null,
  ocr,
});
const units = (qs: EngineQuestion[]) => buildBank(qs, [{ name: '선로', count: 20 }]).items.map((it) => it.qids.length).sort();

const GAP_A = '96, 레일의(부실시 레일길이가25m이•고 레일온도가20℃일 경우 레일!e이음매 유간의 표준은? ① 가. 4mm나. 5mm다, 6mrn라. 7mm';
const GAP_B = '92.레일의 부설시 레일길이가25m이고 레일은도가 20℃일 경우 레일 이음매 유간의 표준은? ㉦4mm 5mm 6mm .@7mm';
const EXIT_A = '90. 도시철도의 정거장이|서 노면 출입구를 지상보도에 설치하는 경우 해당 출입구를 제외한 지상보행로의 폭은 및 m 이상으로 하여야 하는가 ? 가 2m 이상나. 3rn 이상 다. 5m 이상라. 8m 이소!';
const EXIT_B = '92.도시철도의 정거장에서 노면 출입구를 지상보도에 설치하는경우 해당출일구를 제외한지상보행로의 폭은 및 m 이상으로 하여야하는가? ①2m 이상①3m 이상 ①5m 이상8m 이상';

describe('OCR 같은 문항 묶기', () => {
  it('글자가 조금씩 다른 같은 문항을 회차를 건너 하나로 묶는다(n회 출제)', () => {
    expect(units([Q(2013, GAP_A), Q(2019, GAP_B), Q(2011, EXIT_A), Q(2015, EXIT_B)])).toEqual([2, 2]);
  });

  it('글자층 문제팩(OCR 아님)은 글자 완전 일치만 — 예전 그대로', () => {
    expect(units([Q(2013, GAP_A, false), Q(2019, GAP_B, false)])).toEqual([1, 1]);
  });

  it('한 회차 안의 두 문항은 아무리 비슷해도 묶지 않는다', () => {
    expect(units([Q(2013, GAP_A, true, 1), Q(2013, GAP_B, true, 1)])).toEqual([1, 1]);
    // 셋 중 두 개가 같은 회차면, 다른 회차 하나는 둘 중 하나와만 묶인다
    expect(units([Q(2013, GAP_A, true, 1), Q(2013, GAP_B, true, 1), Q(2019, GAP_B)])).toEqual([1, 2]);
  });

  it('물음 방향이 반대(옳은 ↔ 옳지 않은)면 묶지 않는다', () => {
    const pos = '84. 장대레일 부설을 위한 선로조건으로 알맞은 것은? 반경 300m 미만의 곡선에는 부설치 않는다 전장 25m 이상의 무도상교량은 피하여야 한다';
    const neg = '97.선로유지관리지침상 장대레일 부설을 위한 선로조건으로 들린 것은? 반경 300m미만의 곡선에는 부설치 않는다 전장25m 이상의 무도상교량은 피하여야 한다';
    expect(polarity(pos)).toBe(1);
    expect(polarity(neg)).toBe(-1);
    expect(guardsPass(pos, neg)).toBe(false);
    expect(units([Q(2017, pos), Q(2018, neg)])).toEqual([1, 1]);
    // OCR이 "틀린"을 놓쳐 방향을 모르는 쪽은 막지 않는다
    expect(polarity('4.전철화시 1500v직류에 비교한25kV 교류의 장점에 대한 설명으로 것은?')).toBe(0);
  });

  it('숫자만 바꾼 계산 변형(곡선반경 400m ↔ 300m)은 묶지 않는다', () => {
    const a = '20. 곡선반경이 400m인 곡선에 부설되는 슬랙의 크기로 옳은 것은?(단, 8 =0 이고. 일반철도) 가. 4mm 나. 5mm 다 6mm 라, 9mm';
    const b = '12. 곡선반지름이 300m인 곡선에 부설되는 슬랙의 크기로 옳은 것은? (단, 9=0 이고, 일반철도이다.) 가. 10mm 나. 15mm 다. 20mm 라. 25mm';
    expect(guardsPass(a, b)).toBe(false);
    expect(units([Q(2010, a), Q(2012, b)])).toEqual([1, 1]);
  });

  it('보기를 통째로 바꾼 변형은 묶지 않는다', () => {
    const a = '19. 보선작업을 보수의 대상이 되는 선로재료에 의하여 분류할 때 궤도보수작업에 속하는 것은? 가. 유간정정작업 나. 레일보수작업 다. 침목교환 라. 궤도갱신';
    const b = '2.보선작업을 보수의 대상이 되는 선로재료에 의하여 분류할 때 궤도보수작업에 속하는 것은? 도상교환 레일교환 총다지기 침목보수작업';
    expect(guardsPass(a, b)).toBe(false);
  });

  it('물음 방향만 반대·숫자만 바꾼 문항은 같은 문항이 아니라 변형 — 다른 학습 단위, 같은 변형 군집, 출제 구성에서도 변형(사용자 2026-11-18)', () => {
    const pos = '84. 장대레일 부설을 위한 선로조건으로 알맞은 것은? 반경 300m 미만의 곡선에는 부설치 않는다 전장 25m 이상의 무도상교량은 피하여야 한다';
    const neg = '97.선로유지관리지침상 장대레일 부설을 위한 선로조건으로 들린 것은? 반경 300m미만의 곡선에는 부설치 않는다 전장25m 이상의 무도상교량은 피하여야 한다';
    const n1 = '20. 곡선반경이 400m인 곡선에 부설되는 슬랙의 크기로 옳은 것은?(단, 8 =0 이고. 일반철도) 가. 4mm 나. 5mm 다 6mm 라, 9mm';
    const n2 = '12. 곡선반지름이 300m인 곡선에 부설되는 슬랙의 크기로 옳은 것은? (단, 9=0 이고, 일반철도이다.) 가. 10mm 나. 15mm 다. 20mm 라. 25mm';
    expect(variantReason(pos, neg)).toBe('polarity');
    expect(variantReason(n1, n2)).toBe('numbers');
    const qs = [Q(2017, pos), Q(2018, neg), Q(2010, n1), Q(2012, n2), Q(2011, EXIT_A), Q(2015, EXIT_B)];
    const bank = buildBank(qs, [{ name: '선로', count: 20 }]);
    expect(bank.items.length).toBe(5);                                         // 출입구만 같은 문항으로 묶임
    const text = new Map(qs.map((q) => [q.qid, q.text]));
    const { concepts, shares } = buildConcepts(bank, (q) => text.get(q) ?? '');
    const key = (qid: string) => bank.itemOf.get(qid)!.key;
    const cl = (qid: string) => concepts.clusterOf.get(key(qid));
    expect(key(qs[0].qid)).not.toBe(key(qs[1].qid));
    expect(cl(qs[0].qid)).toBe(cl(qs[1].qid));                                // 옳은 ↔ 틀린: 변형
    expect(cl(qs[2].qid)).toBe(cl(qs[3].qid));                                // 400m ↔ 300m: 변형
    expect(cl(qs[0].qid)).not.toBe(cl(qs[2].qid));
    expect(shares.observed).toBeGreaterThan(0);
  });

  it('보기 순서까지 같은 글인지(정답 번호를 옮겨도 되는지)', () => {
    expect(orderKey('3. 같은 발문 ① 가 ② 나')).toBe(orderKey('17. 같은 발문 ① 가 ② 나'));
    expect(orderKey('3. 같은 발문 ① 가 ② 나')).not.toBe(orderKey('3. 같은 발문 ① 나 ② 가'));
  });
});
