/**
 * 스캔(OCR) 문제팩의 "같은 문항" 묶기 — ADR 031.
 *
 * 같은 문항 키(`sameKey`)는 글자가 완전히 같아야 한다. 스캔 문제팩은 문항 글이 OCR이라 같은 문항도 글자가 조금씩
 * 달라("옳지"→"들린", "200MPa"→"200뾰a") 한 번도 묶이지 않았다(철도토목기사 15회차 실측 0묶음). 그래서 n회 출제 표시,
 * 자주 나온 문항 먼저, 한 번 익히면 모든 회차 반영이 스캔 문제팩에서 안 됐다.
 *
 * 여기서는 OCR 문항이 낀 학습 단위끼리만, **확실한 것만** 하나로 묶는다(철도토목기사 15회차를 직접 대조해 정한 기준):
 * 1. 같은 과목, 다른 회차(한 회차에 같은 문항이 두 번 나오지 않으므로 묶음 안에 같은 회차 문항이 둘이면 안 묶음)
 * 2. 한글만 남긴 전체 글의 2-gram tf-idf 코사인 ≥ SAME_OCR(0.65). 0.55~0.65에는 보기만 바꾼 변형이 섞임
 * 3. 안전장치 — 하나라도 걸리면 묶지 않음(변형 문항은 정답이 다르므로):
 *    - 물음 방향: 한쪽은 "옳은·알맞은", 다른 쪽은 "옳지 않은·틀린·아닌"
 *    - 숫자: 둘 다 숫자가 6자 이상이면 숫자만 남긴 글의 2-gram 코사인 ≥ 0.6 (곡선반경 400m ↔ 300m의 슬랙 같은 계산 변형)
 *    - 보기 글: 물음표 뒤 한글 2-gram이 둘 다 12종 이상이면 코사인 ≥ 0.5 (보기를 통째로 바꾼 변형)
 * 결과(같은 표본): 117쌍을 묶어 102묶음·219문항, 무작위 22쌍 확인에서 같은 문항 21쌍(나머지 1쌍은 보기 글 기준으로 걸러짐).
 * 글자가 거의 없는 문항(그림·수식뿐, OCR 실패 — 한글 2-gram 12종 미만)은 묶지 않는다.
 */

export const SAME_OCR = 0.65;
const NUM_MIN = 0.6;
const CHOICE_MIN = 0.5;
const MIN_GRAMS = 12;

export interface OcrUnit {
  subjectKey: string;
  /** 이 단위에 든 문항의 회차(packId) */
  packs: Set<string>;
  /** 대표 글(가장 최근 회차 문항) */
  text: string;
  ocr: boolean;
}

const NEG = /않|아닌|틀린|들린|를린|트린|툴린|잘못|먼것|어려운|적절하지|부적절/;
const POS = /옳은|맞는|알맞은|적절한|바른/;

function body(text: string): string {
  return text.normalize('NFKC').replace(/^\s*\d{1,3}\s*[.,]\s*/, '');
}
function splitAtQuestion(b: string): [string, string] {
  const q = b.search(/[?？]/);
  return q >= 0 ? [b.slice(0, q + 1), b.slice(q + 1)] : [b.slice(0, 120), ''];
}
/** 물음 방향: -1 옳지 않은 것, 1 옳은 것, 0 모름(OCR이 낱말을 놓친 경우 포함 — 그때는 막지 않음) */
export function polarity(text: string): number {
  const stem = splitAtQuestion(body(text))[0].replace(/\s/g, '');
  if (NEG.test(stem)) return -1;
  return POS.test(stem) ? 1 : 0;
}
const hangul = (s: string) => s.replace(/[^가-힣]/g, '');
function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, v] of x) s += v * (y.get(k) ?? 0);
  return s / Math.sqrt(na * nb);
}

interface Prep {
  full: Map<string, number>;
  digits: Map<string, number>;
  digitLen: number;
  choices: Map<string, number>;
  pol: number;
}
function prep(text: string): Prep {
  const b = body(text);
  // 보기 원문자(①②…)는 NFKC에서 숫자 1·2…가 되므로 숫자 비교 전에 뺀다
  const d = body(text.replace(/[\u2460-\u2473\u2776-\u277F\u3251-\u325F\u32B1-\u32BF]/g, ' ')).replace(/\D/g, '');
  return { full: bigrams(hangul(b)), digits: bigrams(d), digitLen: d.length, choices: bigrams(hangul(splitAtQuestion(b)[1])), pol: polarity(text) };
}

/** 두 문항이 같은 문항인지의 안전장치(유사도 기준은 따로) */
export function guardsPass(a: string, b: string): boolean {
  return guards(prep(a), prep(b)) === null;
}
/** 같은 문항이 아닌 까닭(같은 주제의 변형) — 통과하면 null */
export type VariantReason = 'polarity' | 'numbers' | 'choices';
export function variantReason(a: string, b: string): VariantReason | null {
  return guards(prep(a), prep(b));
}
function guards(a: Prep, b: Prep): VariantReason | null {
  if (a.pol * b.pol < 0) return 'polarity';
  if (a.digitLen >= 6 && b.digitLen >= 6 && cosine(a.digits, b.digits) < NUM_MIN) return 'numbers';
  if (a.choices.size >= MIN_GRAMS && b.choices.size >= MIN_GRAMS && cosine(a.choices, b.choices) < CHOICE_MIN) return 'choices';
  return null;
}

type Vec = { ids: Int32Array; w: Float32Array };

/**
 * 묶을 단위 쌍(i → j로 합침)을 유사도 높은 순으로 고른 결과. parent[i] = 합쳐 들어갈 단위(자기 자신이면 대표).
 * variants = 같은 주제(유사도 ≥ 0.65)인데 안전장치에 걸린 쌍 — 물음 방향만 반대(옳은 ↔ 틀린)이거나 숫자만 바꾼 계산 문항,
 * 보기를 바꾼 문항. 같은 문항은 아니지만 **변형**이므로 변형 군집에 반드시 함께 넣는다(사용자 2026-11-18, similar.ts).
 * 대상은 OCR 문항이 낀 단위끼리만 — 글자층 문제팩은 글자 완전 일치(sameKey)로 충분하고, 숫자만 바꾼 변형을 잘못 묶을 위험이 없다.
 */
export function ocrMerge(units: OcrUnit[]): { parent: number[]; variants: [number, number][] } {
  const parent = units.map((_, i) => i);
  const variants: [number, number][] = [];
  const idx = units.map((u, i) => (u.ocr ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return { parent, variants };
  const preps = new Map(idx.map((i) => [i, prep(units[i].text)]));
  const df = new Map<string, number>();
  for (const i of idx) for (const k of preps.get(i)!.full.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = idx.length;
  const vocab = new Map<string, number>();
  for (const k of df.keys()) vocab.set(k, vocab.size);
  const vec = new Map<number, Vec>();
  for (const i of idx) {
    const e = [...preps.get(i)!.full].map(([k, c]) => [vocab.get(k)!, (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(k)!)) + 1)] as [number, number]).sort((x, y) => x[0] - y[0]);
    const norm = Math.sqrt(e.reduce((t, [, v]) => t + v * v, 0)) || 1;
    vec.set(i, { ids: Int32Array.from(e.map((x) => x[0])), w: Float32Array.from(e.map((x) => x[1] / norm)) });
  }
  const ok = (i: number) => vec.get(i)!.ids.length >= MIN_GRAMS;
  // 역색인(gram → [단위, 가중치])으로 같은 과목 단위와의 코사인을 모은다
  const post = new Map<number, { j: number; w: number }[]>();
  for (const i of idx) {
    if (!ok(i)) continue;
    const v = vec.get(i)!;
    for (let t = 0; t < v.ids.length; t++) (post.get(v.ids[t]) ?? post.set(v.ids[t], []).get(v.ids[t])!).push({ j: i, w: v.w[t] });
  }
  const acc = new Map<number, number>();
  const pairs: { a: number; b: number; s: number }[] = [];
  for (const i of idx) {
    if (!ok(i)) continue;
    const v = vec.get(i)!;
    acc.clear();
    for (let t = 0; t < v.ids.length; t++)
      for (const { j, w } of post.get(v.ids[t])!) if (j > i && units[j].subjectKey === units[i].subjectKey) acc.set(j, (acc.get(j) ?? 0) + v.w[t] * w);
    for (const [j, s] of acc) {
      if (s < SAME_OCR) continue;
      if (guards(preps.get(i)!, preps.get(j)!) === null) pairs.push({ a: i, b: j, s });
      else variants.push([i, j]);
    }
  }
  pairs.sort((x, y) => y.s - x.s || x.a - y.a || x.b - y.b);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const packs = units.map((u) => new Set(u.packs));
  for (const { a, b } of pairs) {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) continue;
    const [small, big] = packs[ra].size <= packs[rb].size ? [packs[ra], packs[rb]] : [packs[rb], packs[ra]];
    if ([...small].some((p) => big.has(p))) continue; // 같은 회차 문항 둘은 같은 문항일 수 없음
    if (rb > ra) [ra, rb] = [rb, ra]; // 앞쪽(최근 회차) 단위를 대표로
    parent[ra] = rb;
    for (const p of packs[ra]) packs[rb].add(p);
  }
  return { parent: units.map((_, i) => find(i)), variants };
}
