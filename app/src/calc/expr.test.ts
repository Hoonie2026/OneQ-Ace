import { describe, expect, it } from 'vitest';
import { CalcError, evaluate, formatNumber, toDMS } from './expr';

const v = (s: string, mode: 'DEG' | 'RAD' = 'DEG', ans = 0) => evaluate(s, mode, ans).value;
const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('계산기 수식(v0.10)', () => {
  it('사칙·우선순위·괄호·곱 생략', () => {
    expect(v('1+2×3')).toBe(7);
    expect(v('(1+2)×3')).toBe(9);
    expect(v('-2^2')).toBe(-4);
    expect(v('2^-1')).toBe(0.5);
    expect(v('2^3^2')).toBe(512);
    near(v('2π'), 2 * Math.PI);
    expect(v('3(4+1)')).toBe(15);
    expect(v('(1+2')).toBe(3); // 닫는 괄호 생략
    expect(v('1.5E3+1')).toBe(1501);
    expect(v('3²+4²')).toBe(25);
  });

  it('√·∛·log·ln·10ˣ·eˣ', () => {
    expect(v('√(9)')).toBe(3);
    near(v('√2×3'), 3 * Math.SQRT2);
    expect(v('∛(27)')).toBe(3);
    expect(v('log(1000)')).toBe(3);
    near(v('log(2,8)'), 3);
    near(v('ln(e)'), 1);
    expect(v('10^(2)')).toBe(100);
    near(v('e^2'), Math.E ** 2);
    near(v('e^(2)'), Math.E ** 2);
  });

  it('삼각함수 DEG/RAD와 역함수', () => {
    expect(v('sin(30)')).toBe(0.5);
    expect(v('cos(60)')).toBe(0.5);
    near(v('tan(45)'), 1);
    expect(v('sin⁻¹(0.5)')).toBeCloseTo(30, 10);
    near(v('sin(π÷6)', 'RAD'), 0.5);
    expect(() => v('tan(90)')).toThrow(CalcError);
    expect(() => v('sin⁻¹(2)')).toThrow(CalcError);
  });

  it('도·분·초(측량): 입력·삼각함수·표시', () => {
    near(v("50°20′15″"), 50 + 20 / 60 + 15 / 3600);
    near(v("50°20'15\""), 50 + 20 / 60 + 15 / 3600); // 키보드 ' "
    near(v('89°10′'), 89 + 10 / 60);
    near(v('-30°30′'), -30.5);
    // 구면삼각형 내각 합 − 180°: 50°20′ + 66°25′ + 64°35′ − 180 = 1°20′
    expect(toDMS(v('50°20′+66°25′+64°35′-180'))).toBe('1°20′0″');
    expect(toDMS(89.17361111111)).toBe('89°10′25″');
    expect(toDMS(-0.5)).toBe('-0°30′0″');
  });

  it('Pol·Rec(좌표 ↔ 거리·방향각)', () => {
    const p = evaluate('Pol(3,4)');
    expect(p.value).toBe(5);
    near(p.pair!.second, 53.13010235415598);
    const r = evaluate('Rec(10,30)');
    near(r.value, 8.660254037844387);
    near(r.pair!.second, 5);
  });

  it('Ans·오류·표시', () => {
    expect(v('Ans×2', 'DEG', 21)).toBe(42);
    expect(() => v('1÷0')).toThrow(/수학 오류/);
    expect(() => v('1++')).toThrow(/식 오류/);
    expect(() => v('√(-1)')).toThrow(CalcError);
    expect(() => v('')).toThrow(CalcError);
    expect(formatNumber(1 / 3)).toBe('0.3333333333');
    expect(formatNumber(2)).toBe('2');
    expect(formatNumber(123456789012)).toBe('1.23456789×10^11');
    expect(formatNumber(-0.000000000012)).toBe('-1.2×10^-11');
  });
});
