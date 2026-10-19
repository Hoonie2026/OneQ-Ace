/**
 * 웹검색(실기기 v0.6.0 의견): 교재 없이 앱만으로 공부하므로, 처음 보는 문제의 개념을 바로 찾아볼 수 있게
 * 문항 텍스트에서 검색어를 뽑아 구글 검색을 연다.
 *
 * 검색어 = 지문(보기 앞)에서 문항 번호·"(단, …)" 조건·문제 꼬리("~에 대한 설명으로 옳지 않은 것은?" 등)·숫자 값을 뺀 핵심 낱말
 * + 과목명. 지문이 너무 짧으면(그림 문제·수식 글꼴) 보기 글자를 보탠다.
 * 텍스트는 정답 표시를 지운 것이라 검색어에 정답이 새지 않는다(ADR 001).
 */

const PUA = /[\uE000-\uF8FF]/g; // 수식 글꼴 등 읽을 수 없는 글자
const CHOICE = /[①②③④⑤❶❷❸❹❺]/;
/** 문제 꼬리·지시 표현(길이가 긴 것부터) */
const TAILS = [
  /(다음|그림|아래|보기|표)\s*(과|와)\s*같(은|이)/g,
  /(에|와|과)?\s*(대한|관한)\s*설명(으로|중)?\s*(옳지\s*않은|옳은|틀린|맞는|바른|바르지\s*않은|적합한|적합하지\s*않은|적당한|적당하지\s*않은|거리가\s*먼|가장\s*적합한|가장\s*옳은)\s*것은\s*\??/g,
  /(옳지\s*않은|옳은|틀린|맞는|바른|바르지\s*않은|적합한|적합하지\s*않은|적당한|적당하지\s*않은|거리가\s*먼|해당하지\s*않는|해당하는|속하지\s*않는|속하는|아닌|올바른|가장\s*큰|가장\s*작은|가장\s*적합한|가장\s*옳은)\s*것은\s*\??/g,
  /(얼마인가|무엇인가|어느\s*것인가|무엇이라\s*하는가|무엇인지|구하면|구한\s*값은|계산하면|구하시오|값은|는\s*\?|은\s*\?)\s*\??/g,
  /다음\s*(중|은|의)?/g,
  /그림과\s*같(은|이)/g,
  /아래\s*(의|와)?/g,
];

export function searchQuery(text: string, subjectName = ''): string {
  // 보기 번호로 먼저 나눈다(NFKC는 ①을 "1"로 바꿔 버림)
  const parts = (text ?? '')
    .replace(PUA, ' ')
    .replace(/^\s*\d{1,3}\s*\.\s*/, '')
    .split(CHOICE)
    .map((x) => x.normalize('NFKC'));
  let stem = parts[0] ?? '';
  stem = stem.replace(/\(\s*단[,，\s][^)]*\)?/g, ' '); // (단, …) 조건
  for (const re of TAILS) stem = stem.replace(re, ' ');
  stem = stem
    .replace(/[-+]?\d[\d.,:/'"°′″˚´]*\s*(km2|km|m2|m3|mm|cm|m|kg|kN|N|ha|%|초|분|도)?/g, ' ') // 숫자 값
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let words = stem.split(' ').filter((w) => w.length > 1 || /[A-Za-z]/.test(w));
  if (words.join('').length < 6 && parts.length > 1) {
    // 지문이 짧으면 보기 낱말을 보탠다
    const extra = parts
      .slice(1)
      .join(' ')
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    words = [...words, ...extra.slice(0, 6)];
  }
  const q = words.slice(0, 12).join(' ');
  const subj = subjectName.trim();
  return [q, subj && !q.includes(subj) ? subj : ''].filter(Boolean).join(' ').slice(0, 120);
}

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * 구글 검색 "AI 모드"(v0.7.1 — 사용자 요청). `udm=50`이 AI 모드 화면을 연다(구글 검색 URL 매개변수).
 * AI 모드는 대화형이라 낱말 나열 대신 "개념을 설명해 달라"는 문장으로 묻는다. 문제 전체·보기는 보내지 않는다(정답을 바로 알려 주지 않게)
 */
export function aiModeUrl(keywords: string, certName = ''): string {
  const ask = `${keywords} — ${certName ? `${certName} 필기 시험 대비로 ` : ''}이 개념을 쉽게 설명해 줘`;
  return `https://www.google.com/search?udm=50&q=${encodeURIComponent(ask)}`;
}
