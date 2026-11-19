/**
 * 유사 문항(같은 개념) 군집과 시험 구성 비율 — ADR 013.
 *
 * 실기기 v0.6.0(31회차 팩, 하루 1시간·주 6일·164일): 시험일 예상 41.1점. 원인 중 하나는 반복 출제를
 * "글자가 같은 문항"(측량 34회차 9.5%)으로만 셌기 때문이다. 실제 기출은 숫자·표현만 바꾼 변형이 많다
 * (예: 측량기본계획에 포함되지 않는 사항 2013 ↔ 2016 유사도 0.72, 논리연산 AND 결과값 2016 ↔ 2020 0.76,
 * 교호수준측량 D점 표고 2014 ↔ 2017 0.68. 편평률 계산 6377/6356km ↔ 6378/6356km는 0.55라 같은 군집에 넣지 않음 — 보수적).
 * 측량 2015~2022 문항을 앞 회차와 글자 2-gram 코사인 유사도로 대조하면: 0.9 이상 30%, 0.6~0.9 24%, 그 밖 46%
 * (수험생 경험담 "기출 50~70%, 신유형 10~20%"와 같은 범위). 0.6은 같은 개념(구과량, 클로소이드 등)이 묶이는 선.
 *
 * - **개념 군집**: 같은 과목 안에서 유사도 ≥ SIM_VARIANT인 학습 단위를 잇는다(단일 연결). 한 문항을 익히면
 *   같은 군집의 변형 문항도 더 맞힌다(VARIANT_TRANSFER), 변형을 익히는 비용도 적다(outlook.ts).
 * - **시험 구성**: 보유 기출의 뒤쪽 절반 회차를 "시험"으로 보고, 앞 회차와 같은/변형/처음 보는 문항 비율을 잰다.
 *   회차가 적으면 기본값 쪽으로 당긴다.
 * 계산은 순수 함수. 3천 문항 기준 Node 수백 ms라 load.ts가 팩 구성별로 한 번만 계산해 둔다.
 */
import type { Bank, Item } from './items';
import { variantReason } from './ocrSame';

export const SIM_VARIANT = 0.6;
export const SIM_SAME = 0.9;
/** 변형 문항: 원 문항을 익혔을 때 정답 확률이 올라가는 몫(가정 — 실사용 기록으로 보정, 백로그) */
export const VARIANT_TRANSFER = 0.7;
/**
 * 앞 회차를 몇 회차까지 보유했느냐에 따른 시험 구성(측량 2011~2022 34회차 실측, 회차마다 바로 앞 k회차와 대조).
 * 같은 문항은 바로 앞 몇 회차에는 거의 없고 8회차(약 3년) 이상 거슬러 올라가야 나온다 — 오래된 문항을 다시 쓰는 출제 방식.
 * [k, 같은, 변형] — 기출 비율이 회차 수에 따라 0%대(1~3회차)에서 67%(30회차)까지 오른다
 */
export const SHARE_CURVE: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0.016], [2, 0.002, 0.032], [3, 0.003, 0.048], [5, 0.005, 0.07], [8, 0.037, 0.106],
  [12, 0.13, 0.167], [16, 0.225, 0.212], [20, 0.299, 0.225], [25, 0.376, 0.226], [30, 0.427, 0.242],
];

export function curveShares(k: number): { same: number; variant: number } {
  const c = SHARE_CURVE;
  if (k >= c[c.length - 1][0]) return { same: c[c.length - 1][1], variant: c[c.length - 1][2] };
  let i = 1;
  while (c[i][0] < k) i++;
  const [k0, s0, v0] = c[i - 1];
  const [k1, s1, v1] = c[i];
  const t = (k - k0) / (k1 - k0);
  return { same: s0 + t * (s1 - s0), variant: v0 + t * (v1 - v0) };
}
/** 실측을 위 곡선 쪽으로 당기는 가상 문항 수 */
export const SHARE_PSEUDO = 300;
/** 군집에 넣을 최소 글자 2-gram 종류 수 */
export const MIN_GRAMS = 12;

export interface Concepts {
  /** item.key → 군집 id(대표 item.key) */
  clusterOf: Map<string, string>;
  /** 군집 id → 학습 단위들 */
  members: Map<string, Item[]>;
}

export interface ExamShares {
  same: number;
  variant: number;
  fresh: number;
  /** 근거가 된 문항 수 */
  observed: number;
}

const CLEAN = /[\s①②③④⑤❶❷❸❹❺0-9.,()[\]{}:;~\-+=*/×÷<>?!'"“”‘’·]+/g;

/**
 * 스캔(OCR) 문항의 변형 군집(v0.21, ADR 031): OCR 잡음(숫자·영문·한자 깨짐) 때문에 위 방식으로는 같은 개념 문항이 잘 안 묶여
 * (철도토목 15회차 33군집), 출제 구성 실측(examShares)과 같은 **한글만 남긴 글**로 비교하고 기준도 그쪽 변형 기준에 맞춘다.
 * OCR 단위끼리만 이 방식으로 비교하고(글자층 단위와는 비교하지 않음), 글자층 문제팩은 예전 그대로.
 */
export const SIM_VARIANT_OCR = 0.5;

function grams(text: string, ocr = false): Map<string, number> {
  const out = new Map<string, number>();
  if (ocr) {
    const h = text.replace(/^\s*\d{1,3}\s*[.,]\s*/, '').normalize('NFKC').replace(/[^가-힣]/g, '');
    for (let i = 0; i < h.length - 1; i++) {
      const g = '\u0001' + h.slice(i, i + 2); // 글자층 gram과 섞이지 않게 표시
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  }
  const body = text.replace(/^\s*\d{1,3}\s*\.\s*/, '').normalize('NFKC');
  for (const w of body.replace(CLEAN, ' ').split(' ')) {
    if (!w) continue;
    if (w.length === 1) out.set(w, (out.get(w) ?? 0) + 1);
    for (let i = 0; i < w.length - 1; i++) {
      const g = w.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
  }
  return out;
}

type Vec = { ids: Int32Array; w: Float32Array };

function dot(a: Vec, b: Vec): number {
  let i = 0;
  let j = 0;
  let s = 0;
  while (i < a.ids.length && j < b.ids.length) {
    const x = a.ids[i];
    const y = b.ids[j];
    if (x === y) {
      s += a.w[i++] * b.w[j++];
    } else if (x < y) i++;
    else j++;
  }
  return s;
}

/** 학습 단위 사이 유사도 ≥ SIM_VARIANT 쌍(같은 과목). 대표 텍스트 = 학습 단위의 첫 문항 */
export function similarPairs(items: Item[], textOf: (qid: string) => string): { a: number; b: number; sim: number }[] {
  const raw = items.map((it) => grams(textOf(it.qids[0]) ?? '', !!it.ocr));
  const df = new Map<string, number>();
  for (const g of raw) for (const k of g.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const vocab = new Map<string, number>();
  for (const k of df.keys()) vocab.set(k, vocab.size);
  const n = items.length;
  const vecs: Vec[] = raw.map((g) => {
    const e = [...g].map(([k, c]) => [vocab.get(k)!, (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(k)!)) + 1)] as [number, number]).sort((x, y) => x[0] - y[0]);
    const norm = Math.sqrt(e.reduce((t, [, v]) => t + v * v, 0)) || 1;
    return { ids: Int32Array.from(e.map((x) => x[0])), w: Float32Array.from(e.map((x) => x[1] / norm)) };
  });
  // 후보: 드문 gram(문서 비율 5% 이하)을 둘 이상 공유하는 같은 과목 단위
  const rare = Math.max(3, Math.floor(n * 0.05));
  const post = new Map<number, number[]>();
  vecs.forEach((v, i) => {
    for (let t = 0; t < v.ids.length; t++) {
      const id = v.ids[t];
      (post.get(id) ?? post.set(id, []).get(id)!).push(i);
    }
  });
  const dfById = new Int32Array(vocab.size);
  for (const [k, id] of vocab) dfById[id] = df.get(k)!;
  const out: { a: number; b: number; sim: number }[] = [];
  const hits = new Int32Array(n);
  // 글자가 거의 없는 문항(그림뿐·수식 글꼴·OCR 실패)은 묶지 않는다 — 짧은 텍스트끼리 우연히 같아 보이는 것을 막음
  const tooShort = vecs.map((v) => v.ids.length < MIN_GRAMS);
  for (let i = 0; i < n; i++) {
    if (tooShort[i]) continue;
    const touched: number[] = [];
    for (const id of vecs[i].ids) {
      if (dfById[id] > rare) continue;
      for (const j of post.get(id)!) {
        if (j <= i || tooShort[j] || items[j].subjectKey !== items[i].subjectKey || !!items[j].ocr !== !!items[i].ocr) continue;
        if (hits[j]++ === 0) touched.push(j);
      }
    }
    for (const j of touched) {
      if (hits[j] >= 2) {
        const s = dot(vecs[i], vecs[j]);
        if (s >= (items[i].ocr ? SIM_VARIANT_OCR : SIM_VARIANT)) out.push({ a: i, b: j, sim: s });
      }
      hits[j] = 0;
    }
  }
  return out;
}

export function buildConcepts(bank: Bank, textOf: (qid: string) => string): { concepts: Concepts; shares: ExamShares } {
  const items = bank.items;
  const pairs = similarPairs(items, textOf);
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const p of pairs) parent[find(p.a)] = find(p.b);
  // 스캔본: 같은 주제인데 물음 방향만 반대이거나 숫자만 바꾼 문항은 같은 문항이 아니라 변형 — 유사도와 관계없이 같은 군집(ADR 031)
  if (bank.variantLinks?.length) {
    const pos = new Map(items.map((it, i) => [it.key, i]));
    for (const [a, b] of bank.variantLinks) {
      const x = pos.get(a);
      const y = pos.get(b);
      if (x !== undefined && y !== undefined) parent[find(x)] = find(y);
    }
  }
  const clusterOf = new Map<string, string>();
  const members = new Map<string, Item[]>();
  items.forEach((it, i) => {
    const id = items[find(i)].key;
    clusterOf.set(it.key, id);
    (members.get(id) ?? members.set(id, []).get(id)!).push(it);
  });

  return { concepts: { clusterOf, members }, shares: examShares(bank, textOf) };
}

/**
 * 시험 구성 실측(v0.20 — 사용자 2026-11-18: 철도토목기사 15회차 "신규 79%"가 상식과 맞지 않음).
 * 스캔 PDF 문제팩은 문항 글이 OCR이라 같은 문항도 글자가 조금씩 다르다("옳지"→"들린", "200MPa"→"200뾰a").
 * 그래서 예전 기준(유사도 0.9 이상만 "같은 문항")으로는 15년 동안 같은 문항이 0개로 잡혔다.
 * 이제 한글만 남긴 글로 ① 문제 줄기(물음표까지)와 ② 전체 글을 각각 대조해 더 높은 값을 쓰고,
 * 문항마다 **앞 회차 전체에서 가장 비슷한 문항** 하나와 견준다. 기준은 철도토목 15회차를 사람이 직접 대조해 정했다:
 *   ≥ SHARE_SAME(0.55) 거의 모두 같은 문항(OCR 잡음만 다름) · SHARE_VARIANT(0.45)~0.55 같은 개념의 변형이 많음 · 그 아래는 다른 문항
 * 최근 1/3 회차를 "시험"으로 보고 잰 값을, 보유 기간(햇수)에 맞는 곡선 값 쪽으로 당긴다.
 */
/** 출제 구성·군집 계산 방식의 판 — 바꾸면 기기에 저장된 계산을 다시 한다(load.ts) */
export const SHARES_VERSION = 4;
export const SHARE_SAME = 0.55;
export const SHARE_VARIANT = 0.45;
/** 측량 34회차(2011~2022, 12년)의 한 해 평균 회차 수 — 곡선을 햇수로 읽을 때 쓴다 */
export const SURVEY_ROUNDS_PER_YEAR = 34 / 12;

const yearOf = (d: string) => Number(d.slice(0, 4)) || 0;
/** 보유 기출이 덮는 햇수(첫 해 ~ 마지막 해) */
export function coveredYears(dates: Iterable<string>): number {
  const ys = [...dates].map(yearOf).filter((y) => y > 0);
  return ys.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0;
}
/**
 * 보유 기출로 본 시험 구성의 기본값: 같은 문항은 몇 해 지난 문항에서 다시 나오므로 **회차 수가 아니라 덮는 햇수**로 곡선을 읽는다
 * (철도토목기사 15회차 = 15년 ≈ 측량 42회차 깊이. 예전에는 회차 수로 읽어 측량 4년치로 계산했다)
 */
export function baseShares(dates: Iterable<string>): { same: number; variant: number } {
  const list = [...dates];
  const rounds = new Set(list).size;
  const byYears = coveredYears(list) * SURVEY_ROUNDS_PER_YEAR;
  return curveShares(Math.max(rounds, byYears));
}

function hangul(s: string): string {
  return s.normalize('NFKC').replace(/[^가-힣]/g, '');
}
function shareTexts(text: string): [string, string] {
  const body = text.replace(/^\s*\d{1,3}\s*[.,]\s*/, '');
  const q = body.search(/[?？]/);
  return [hangul(q >= 0 ? body.slice(0, q + 1) : body.slice(0, 120)), hangul(body)];
}

export function examShares(bank: Bank, textOf: (qid: string) => string): ExamShares {
  const dates = [...new Set(bank.examDateOf.values())].sort();
  const base = baseShares(bank.examDateOf.values());
  if (dates.length < 2) return { same: base.same, variant: base.variant, fresh: Math.max(0, 1 - base.same - base.variant), observed: 0 };
  // 시험에 나온 문항 하나하나(같은 글의 문항도 회차마다 따로)
  const qs: { qid: string; subj: string; date: string; v: [Vec, Vec] }[] = [];
  const raw: { qid: string; subj: string; date: string; g: [Map<string, number>, Map<string, number>] }[] = [];
  for (const it of bank.items)
    for (const q of it.qids) {
      const [st, full] = shareTexts(textOf(q) ?? '');
      raw.push({ qid: q, subj: it.subjectKey, date: bank.examDateOf.get(q) ?? '', g: [bigrams(st), bigrams(full)] });
    }
  const df = new Map<string, number>();
  for (const r of raw) for (const k of r.g[1].keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const n = raw.length;
  const vocab = new Map<string, number>();
  const toVec = (g: Map<string, number>): Vec => {
    const e = [...g].map(([k, c]) => {
      if (!vocab.has(k)) vocab.set(k, vocab.size);
      return [vocab.get(k)!, (1 + Math.log(c)) * (Math.log((1 + n) / (1 + (df.get(k) ?? 0))) + 1)] as [number, number];
    });
    e.sort((x, y) => x[0] - y[0]);
    const norm = Math.sqrt(e.reduce((t, [, v]) => t + v * v, 0)) || 1;
    return { ids: Int32Array.from(e.map((x) => x[0])), w: Float32Array.from(e.map((x) => x[1] / norm)) };
  };
  for (const r of raw) qs.push({ qid: r.qid, subj: r.subj, date: r.date, v: [toVec(r.g[0]), toVec(r.g[1])] });
  // 역색인(gram → [문항, 가중치])으로 같은 과목·앞 회차 문항과의 코사인을 모은다(줄기·전체 각각)
  // 다음 시험은 보유 기출 전체를 앞에 두고 치르므로, 앞 회차가 충분히 쌓인 최근 1/3 회차로 잰다(최소 1회차)
  const cut = dates[Math.min(dates.length - 1, Math.ceil((2 * dates.length) / 3))];
  const post: Map<number, { j: number; w: number }[]>[] = [new Map(), new Map()];
  qs.forEach((q, i) => {
    for (const k of [0, 1] as const) {
      const v = q.v[k];
      for (let t = 0; t < v.ids.length; t++) (post[k].get(v.ids[t]) ?? post[k].set(v.ids[t], []).get(v.ids[t])!).push({ j: i, w: v.w[t] });
    }
  });
  const acc = new Float32Array(n);
  // 한글이 거의 없는 글(그림 문항·수식·OCR 실패)은 짧은 글끼리 우연히 같아 보이므로 대조하지 않는다(보수적으로 '처음 보는 문항')
  const bestOf = (k: 0 | 1, i: number): { m: number; j: number } => {
    const v = qs[i].v[k];
    if (v.ids.length < MIN_GRAMS) return { m: 0, j: -1 };
    const touched: number[] = [];
    for (let t = 0; t < v.ids.length; t++) {
      for (const { j, w } of post[k].get(v.ids[t])!) {
        if (qs[j].date >= qs[i].date || qs[j].subj !== qs[i].subj || qs[j].v[k].ids.length < MIN_GRAMS) continue;
        if (acc[j] === 0) touched.push(j);
        acc[j] += v.w[t] * w;
      }
    }
    let m = 0;
    let best = -1;
    for (const j of touched) {
      if (acc[j] > m) {
        m = acc[j];
        best = j;
      }
      acc[j] = 0;
    }
    return { m, j: best };
  };
  let same = 0;
  let variant = 0;
  let obs = 0;
  qs.forEach((q, i) => {
    if (q.date < cut) return;
    obs++;
    const a = bestOf(0, i);
    const b = bestOf(1, i);
    const { m, j } = a.m >= b.m ? a : b;
    // 같은 주제라도 물음 방향만 반대(옳은 ↔ 틀린)·숫자만 바꾼 계산·보기를 바꾼 문항은 같은 문항이 아니라 변형(사용자 2026-11-18, ADR 031)
    if (m >= SHARE_SAME && variantReason(textOf(q.qid) ?? '', textOf(qs[j].qid) ?? '') === null) same++;
    else if (m >= SHARE_SAME) variant++;
    else if (m >= SHARE_VARIANT) variant++;
  });
  const s = (same + SHARE_PSEUDO * base.same) / (obs + SHARE_PSEUDO);
  const v = (variant + SHARE_PSEUDO * base.variant) / (obs + SHARE_PSEUDO);
  return { same: s, variant: v, fresh: Math.max(0, 1 - s - v), observed: obs };
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}


/** 군집이 없을 때(시험·가상 학습자): 학습 단위 하나 = 군집 하나, 구성은 보유 회차 수의 곡선 값 */
export function trivialConcepts(bank: Bank): { concepts: Concepts; shares: ExamShares } {
  const clusterOf = new Map(bank.items.map((it) => [it.key, it.key]));
  const members = new Map(bank.items.map((it) => [it.key, [it]]));
  const { same, variant } = baseShares(bank.examDateOf.values());
  return { concepts: { clusterOf, members }, shares: { same, variant, fresh: 1 - same - variant, observed: 0 } };
}
