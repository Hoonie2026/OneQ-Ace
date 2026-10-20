/**
 * 계산 문제 판정(v0.10). 계산 문제면 풀이 화면에서 계산기·메모가 저절로 열린다.
 * 1) 팩에 전처리기·검수자가 확정한 표시가 있으면 그대로: flags "calc" / "no-calc"
 * 2) 없으면 문항 글자로 추정 — 보기 대부분이 숫자 + 지문에 숫자, 또는 "구하면·얼마·값은" 같은 말 + 지문 숫자 2개 이상.
 *    측량 2022-1회차 100문항: 27문항 판정, 눈 검토 오판 1(축척계수 암기 문항). 잘못 열려도 닫으면 그만이라 넓게 잡는다
 */
const VERB = /(구하|계산|얼마|값은|값을|크기는|면적은|거리는|높이는|오차는|좌표는|각은|방위각은|표고는|체적은|축척은|길이는|반지름은|경사는|유량은|속도는|무게는|하중은|응력은|모멘트는|비율은|몇)/;
const CIRCLED = /[①②③④⑤]/;

function numericChoice(c: string): boolean {
  const t = c.replace(/\s+/g, '');
  if (!t) return false;
  const digits = (t.match(/\d/g) ?? []).length;
  const hangul = (t.match(/[가-힣]/g) ?? []).length;
  return digits >= 1 && digits >= hangul;
}

export function looksLikeCalc(text: string): boolean {
  const parts = text.split(CIRCLED);
  const stem = parts[0].replace(/^\s*\d+\.\s*/, ''); // 문항 번호 "94. " 제외
  const choices = parts.slice(1);
  const numericChoices = choices.filter(numericChoice).length;
  const stemNumbers = (stem.match(/\d+(?:\.\d+)?/g) ?? []).length;
  const verb = VERB.test(stem);
  return (choices.length > 0 && numericChoices >= Math.min(3, choices.length) && (stemNumbers >= 1 || verb)) || (verb && stemNumbers >= 2);
}

export function isCalcQuestion(q: { text?: string; flags?: string[] }): boolean {
  if (q.flags?.includes('calc')) return true;
  if (q.flags?.includes('no-calc')) return false;
  return looksLikeCalc(q.text ?? '');
}
