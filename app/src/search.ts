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

const MAX_WORDS = 12;
/** 숫자를 지운 자리에 남는 단위·조사 꼬리 — 낱말 앞(공백 뒤)에 붙은 것만 */
const COUNTER_LEFT = /(^|\s)(명|건|일|시간|회|년|개월|개|주|번|배|급|원|인)(의|이|을|를|인|은|는|씩|당|간|에|으로|로|과|와)?(?=\s|$)/g;
/** 검색에 도움이 안 되는 낱말 */
const FILLER = new Set(['어떤', '이라면', '이고', '이며', '이었다', '이었을', '약', '몇', '이', '그', '때', '때의', '이때', '경우', '중', '및', '얼마', '얼마인가', '얼마인가요']);
/** 줄 끝에 이 글자로 끝나는 2글자 이상 어절은 낱말이 끝난 것으로 본다(조사·어미) */
const WORD_END = /[을를은는이가의에서도와과고며면여한된인할로게지다요]$/;

/**
 * 기출 PDF 글은 한글 낱말 중간에서 줄이 바뀐다("강⏎도율", "근로손⏎실일수"). 한글과 한글 사이 줄바꿈은 이어 붙이되,
 * 줄 끝 어절이 2글자 이상이고 조사·어미로 끝나면 낱말 경계로 보고 띄운다("등을⏎통한").
 */
export function joinWrappedLines(text: string): string {
  return text.replace(/(\S*)\r?\n(?=(\S))/g, (_m, before: string, next: string) => {
    const last = before.slice(-1);
    if (!/[가-힣]/.test(last) || !/[가-힣]/.test(next)) return `${before} `;
    const seg = before.match(/[가-힣]+$/)?.[0] ?? '';
    if (seg.length >= 2 && WORD_END.test(seg)) return `${before} `;
    return before;
  });
}

export function searchQuery(text: string, subjectName = ''): string {
  // 보기 번호로 먼저 나눈다(NFKC는 ①을 "1"로 바꿔 버림)
  const parts = joinWrappedLines(text ?? '')
    .replace(PUA, ' ')
    .replace(/^\s*\d{1,3}\s*\.\s*/, '')
    .split(CHOICE)
    .map((x) => x.normalize('NFKC'));
  let stem = parts[0] ?? '';
  stem = stem.replace(/\(\s*단[,，\s][^)]*\)?/g, ' '); // (단, …) 조건
  for (const re of TAILS) stem = stem.replace(re, ' ');
  stem = stem
    .replace(/[-+]?\d[\d.,:/'"°′″˚´]*\s*(km2|km|m2|m3|mm|cm|m|kg|kN|N|ha|%|초|분|도)?/g, ' ') // 숫자 값
    .replace(COUNTER_LEFT, ' ') // 숫자를 뺀 뒤 남은 단위 꼬리(1000명의 → 명의)
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
  words = words.filter((w) => !FILLER.has(w));
  // 묻는 대상(강도율·도수율 등)은 보통 지문 맨 끝(꼬리 바로 앞)에 온다 → 길면 앞 8 + 끝 4
  const picked = words.length > MAX_WORDS ? [...words.slice(0, MAX_WORDS - 4), ...words.slice(-4)] : words;
  const q = picked.join(' ');
  const subj = subjectName.trim();
  return [q, subj && !q.includes(subj) ? subj : ''].filter(Boolean).join(' ').slice(0, 120);
}

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * 웹검색에 보낼 핵심 문장(v0.21.4 — 사용자 결정 2026-11-19): AI 모드는 대화형이라 낱말을 뽑는 것보다
 * 문제 문장(발문)을 그대로 보내는 편이 정확하다. 줄바꿈으로 끊긴 낱말은 잇고, 문항 번호와 보기는 뺀다.
 * 계산 문제의 숫자·"(단, …)" 조건은 풀이에 필요하므로 남긴다. 웹검색은 답한 뒤에만 열리므로 정답 노출 걱정은 없다.
 * 발문이 너무 짧으면(그림 문제·수식 글꼴) 보기를 붙인다.
 */
export function questionSentence(text: string): string {
  const parts = joinWrappedLines(text ?? '')
    .replace(PUA, ' ')
    .replace(/^\s*\d{1,3}\s*\.\s*/, '')
    .split(CHOICE)
    .map((x) => x.replace(/\s+/g, ' ').trim());
  let out = parts[0] ?? '';
  if (out.replace(/[^\p{L}]/gu, '').length < 8 && parts.length > 1) {
    const opts = parts.slice(1).filter(Boolean).map((x, i) => `(${i + 1}) ${x}`).join(' ');
    out = `${out} 보기: ${opts}`.trim();
  }
  return out.slice(0, 400);
}

/**
 * 구글 검색 "AI 모드"(v0.7.1 — 사용자 요청). `udm=50`이 AI 모드 화면을 연다(구글 검색 URL 매개변수).
 * v0.21.4: 핵심 문장(questionSentence)과 과목을 보내고 개념과 풀이를 묻는다.
 */
export function aiModeUrl(sentence: string, certName = '', subjectName = ''): string {
  const ctx = [certName && `${certName} 필기`, subjectName && `${subjectName} 과목`].filter(Boolean).join(' ');
  const ask = `${sentence}\n\n${ctx ? `${ctx} 문제입니다. ` : ''}이 문제의 핵심 개념과 풀이 방법을 쉽게 설명해 줘`;
  return `https://www.google.com/search?udm=50&q=${encodeURIComponent(ask)}`;
}
