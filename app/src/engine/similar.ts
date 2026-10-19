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

function grams(text: string): Map<string, number> {
  const out = new Map<string, number>();
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
  const raw = items.map((it) => grams(textOf(it.qids[0]) ?? ''));
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
        if (j <= i || tooShort[j] || items[j].subjectKey !== items[i].subjectKey) continue;
        if (hits[j]++ === 0) touched.push(j);
      }
    }
    for (const j of touched) {
      if (hits[j] >= 2) {
        const s = dot(vecs[i], vecs[j]);
        if (s >= SIM_VARIANT) out.push({ a: i, b: j, sim: s });
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
  const clusterOf = new Map<string, string>();
  const members = new Map<string, Item[]>();
  items.forEach((it, i) => {
    const id = items[find(i)].key;
    clusterOf.set(it.key, id);
    (members.get(id) ?? members.set(id, []).get(id)!).push(it);
  });

  // 시험 구성: 뒤쪽 절반 회차의 문항마다, 앞 회차에 같은(동일 묶음 또는 유사도 ≥ SIM_SAME) / 변형(≥ SIM_VARIANT) 문항이 있었나
  const dates = [...new Set(bank.examDateOf.values())].sort();
  const firstDate = items.map((it) => it.qids.map((q) => bank.examDateOf.get(q) ?? '').sort()[0]);
  const nb: { j: number; sim: number }[][] = items.map(() => []);
  for (const p of pairs) {
    nb[p.a].push({ j: p.b, sim: p.sim });
    nb[p.b].push({ j: p.a, sim: p.sim });
  }
  let same = 0;
  let variant = 0;
  let obs = 0;
  if (dates.length >= 2) {
    const cut = dates[Math.floor(dates.length / 2)];
    items.forEach((it, i) => {
      for (const q of it.qids) {
        const d = bank.examDateOf.get(q) ?? '';
        if (d < cut) continue;
        obs++;
        if (it.qids.some((o) => (bank.examDateOf.get(o) ?? '') < d) || nb[i].some((x) => x.sim >= SIM_SAME && firstDate[x.j] < d)) same++;
        else if (nb[i].some((x) => firstDate[x.j] < d)) variant++;
      }
    });
  }
  // 실측은 뒤쪽 절반 회차를 그 앞 회차 전체와 대조한 값(평균 깊이 약 0.75 × 회차 수) — 같은 깊이의 곡선 값 쪽으로 당긴다.
  // 보유 회차를 다 쓰는 실제 시험이면 조금 더 높겠지만, 최근 회차(2022 이후 CBT 비공개)가 비어 있어 보수적으로 둔다
  const base = curveShares(0.75 * dates.length);
  const s = (same + SHARE_PSEUDO * base.same) / (obs + SHARE_PSEUDO);
  const v = (variant + SHARE_PSEUDO * base.variant) / (obs + SHARE_PSEUDO);
  return { concepts: { clusterOf, members }, shares: { same: s, variant: v, fresh: Math.max(0, 1 - s - v), observed: obs } };
}

/** 군집이 없을 때(시험·가상 학습자): 학습 단위 하나 = 군집 하나, 구성은 보유 회차 수의 곡선 값 */
export function trivialConcepts(bank: Bank): { concepts: Concepts; shares: ExamShares } {
  const clusterOf = new Map(bank.items.map((it) => [it.key, it.key]));
  const members = new Map(bank.items.map((it) => [it.key, [it]]));
  const { same, variant } = curveShares(0.75 * new Set(bank.examDateOf.values()).size);
  return { concepts: { clusterOf, members }, shares: { same, variant, fresh: 1 - same - variant, observed: 0 } };
}
