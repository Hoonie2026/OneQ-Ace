/**
 * 과목 묶음과 동일 문항(출제빈도) — ADR 004·006.
 *
 * - 과목은 번호가 아니라 **정규화한 과목명**으로 묶는다. 현행 과목 = 가장 최근 회차의 과목 목록.
 * - **동일 문항**: 문항 텍스트에서 문항 번호·공백·문장부호를 지우고 보기 순서를 무시한 키가 같은 문항.
 *   팩의 contentHash는 문항 번호("39.")까지 포함해 해시하므로 다른 회차의 같은 문항도 값이 달라
 *   출제빈도에 쓸 수 없다(측량 34회차 실측: contentHash 일치 13쌍 vs 이 키 281묶음·593문항).
 *   contentHash는 기록 재연결(ADR 002) 용도로 그대로 둔다.
 * - **스캔(OCR) 문제팩**은 글자가 조금씩 달라 위 키로는 묶이지 않으므로, OCR 문항이 낀 단위끼리 한글 유사도로
 *   확실한 것만 한 번 더 묶는다(ocrSame.ts, ADR 031).
 * - **학습 단위(item)** = 동일 문항 묶음. 기억은 문항이 아니라 내용에 쌓이므로 한 회차에서 푼 기록이
 *   다른 회차의 같은 문항에도 적용된다. 묶음 크기 = 출제빈도.
 */
import { ocrMerge } from './ocrSame';
import type { Concepts, ExamShares } from './similar';
import type { EngineQuestion } from './types';

/** 과목명 정규화: 공백·가운뎃점·괄호 표기 차이를 지운다(ADR 004) */
export function subjectKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\s·ㆍ•∙・.,()[\]{}<>〈〉「」『』]/g, '')
    .toLowerCase();
}

const CHOICE_RE = /[①②③④⑤]/;

/** 동일 문항 키: 문항 번호·공백·부호 제거, 보기 순서 무시 */
export function sameKey(text: string): string {
  const clean = (s: string) => s.normalize('NFKC').replace(/[^0-9A-Za-z가-힣\u3131-\u318E]/g, '').toLowerCase();
  const parts = text.replace(/^\s*\d{1,3}\s*\.\s*/, '').split(CHOICE_RE);
  if (parts.length < 3) return clean(parts.join('')); // 보기를 못 찾으면 전체 텍스트
  const [stem, ...choices] = parts;
  return `${clean(stem)}|${choices.map(clean).sort().join('|')}`;
}

/**
 * 보기 순서까지 같은 글인지의 키(문항 번호·공백·부호만 지움). 정답 번호를 다른 회차 문항에 그대로 옮겨도 되는지 판단에 쓴다 —
 * sameKey는 보기 순서를 무시하므로 정답 번호 옮기기에는 쓸 수 없다(ADR 031).
 */
export function orderKey(text: string): string {
  return text.replace(/^\s*\d{1,3}\s*[.,]\s*/, '').normalize('NFKC').replace(/[^0-9A-Za-z가-힣\u3131-\u318E]/g, '').toLowerCase();
}

export interface Subject {
  key: string;
  name: string; // 가장 최근 회차의 표기
  /** 실제 시험의 과목 문항 수(가장 최근 회차 기준). 모의고사 출제 수 */
  examCount: number;
  /** 현행 과목인가(가장 최근 회차에 있는가) */
  current: boolean;
}

export interface Item {
  /** 동일 문항 키(학습 단위 id) */
  key: string;
  subjectKey: string;
  /** 이 내용의 모든 문항(출제빈도 = qids.length). 최근 회차 순 */
  qids: string[];
  clusterId: string | null;
  /** 스캔본 OCR 문항이 든 단위(ADR 031) — 변형 군집도 한글만 남긴 글로 비교한다 */
  ocr?: boolean;
}

export interface Bank {
  subjects: Subject[];
  /** 현행 과목의 학습 단위만(폐지 과목은 전처리에서 빠지지만, 남아 있어도 계획·점수에서 제외) */
  items: Item[];
  itemOf: Map<string, Item>; // qid → item
  /** 과목별 보유 문항 수 N_s(동일 문항도 각각 센다 — 실제 시험에 각각 출제된 횟수) */
  questionCount: Map<string, number>;
  /** 문항의 시행일(qid → YYYY-MM-DD). 출제 이력 표시·반복 출제 비율에 쓴다 */
  examDateOf: Map<string, string>;
  /** 유사 문항(같은 개념) 군집과 시험 구성 비율(ADR 013). load.ts가 채운다 — 없으면 학습 단위 하나 = 군집 하나 */
  concepts?: Concepts;
  shares?: ExamShares;
  /** 스캔본에서 같은 주제지만 같은 문항은 아닌 쌍(item.key) — 변형 군집에 반드시 함께(ADR 031) */
  variantLinks?: [string, string][];
}

const mergeCache = new Map<string, { parent: number[]; variants: [number, number][] }>();

/**
 * 한 종목의 문항 전체로 학습 단위를 만든다.
 * @param subjectCounts 가장 최근 팩 manifest의 과목별 문항 수(없으면 그 회차의 문항 수를 센다)
 */
export function buildBank(questions: EngineQuestion[], subjectCounts?: { name: string; count: number }[]): Bank {
  const latestDate = questions.reduce((m, q) => (q.examDate > m ? q.examDate : m), '');
  const latestPack = questions.filter((q) => q.examDate === latestDate);
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  if (subjectCounts?.length) {
    for (const s of subjectCounts) {
      names.set(subjectKey(s.name), s.name);
      counts.set(subjectKey(s.name), s.count);
    }
  } else {
    for (const q of latestPack) {
      const k = subjectKey(q.subjectName);
      names.set(k, q.subjectName);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const subjects: Subject[] = [...names].map(([key, name]) => ({ key, name, examCount: counts.get(key) ?? 0, current: true }));
  const seen = new Set(subjects.map((s) => s.key));
  for (const q of questions) {
    const k = subjectKey(q.subjectName);
    if (!seen.has(k)) {
      seen.add(k);
      subjects.push({ key: k, name: q.subjectName, examCount: 0, current: false });
    }
  }

  const sorted = [...questions].sort((a, b) => (a.examDate === b.examDate ? a.qid.localeCompare(b.qid) : a.examDate < b.examDate ? 1 : -1));
  const byKey = new Map<string, Item>();
  const itemOf = new Map<string, Item>();
  const questionCount = new Map<string, number>();
  const examDateOf = new Map<string, string>();
  for (const q of sorted) {
    examDateOf.set(q.qid, q.examDate);
    const sk = subjectKey(q.subjectName);
    if (!names.has(sk)) continue;
    questionCount.set(sk, (questionCount.get(sk) ?? 0) + 1);
    // 같은 내용이 다른 과목에 실린 경우(실측 소수)는 과목별로 따로 센다 — 과목 점수에 각각 들어가므로
    const key = `${sk}#${sameKey(q.text)}`;
    let it = byKey.get(key);
    if (!it) {
      it = { key, subjectKey: sk, qids: [], clusterId: q.clusterId, ...(q.ocr ? { ocr: true } : {}) };
      byKey.set(key, it);
    }
    it.qids.push(q.qid);
    if (q.ocr) it.ocr = true;
    itemOf.set(q.qid, it);
  }
  let items = [...byKey.values()];
  let variantLinks: [string, string][] = [];
  if (questions.some((q) => q.ocr)) {
    const byQid = new Map(questions.map((q) => [q.qid, q]));
    // 수천 문항이면 휴대폰에서 수백 ms — 같은 문항 구성이면 이번 실행 동안 결과를 다시 쓴다
    const sig = items.map((it) => `${it.key.length}:${it.qids.join(',')}`).join('|');
    let merged = mergeCache.get(sig);
    if (!merged) {
      merged = ocrMerge(
        items.map((it) => ({
          subjectKey: it.subjectKey,
          packs: new Set(it.qids.map((x) => byQid.get(x)!.packId)),
          text: byQid.get(it.qids[0])!.text,
          ocr: it.qids.some((x) => byQid.get(x)!.ocr),
        })),
      );
      if (mergeCache.size > 4) mergeCache.clear();
      mergeCache.set(sig, merged);
    }
    const par = merged.parent;
    // 같은 주제의 변형(물음 방향만 반대·숫자만 바꿈·보기 바꿈) — 합친 뒤의 대표 단위 key로
    variantLinks = merged.variants.map(([a, b]) => [items[par[a]].key, items[par[b]].key] as [string, string]).filter(([a, b]) => a !== b);
    par.forEach((p, i) => {
      if (p === i) return;
      const into = items[p];
      for (const x of items[i].qids) itemOf.set(x, into);
      into.qids.push(...items[i].qids);
      if (items[i].ocr) into.ocr = true;
    });
    items = items.filter((_, i) => par[i] === i);
    // 묶음 안은 최근 회차 순(출제 이력·대표 문항)
    for (const it of items) it.qids.sort((a, b) => (examDateOf.get(a)! === examDateOf.get(b)! ? a.localeCompare(b) : examDateOf.get(a)! < examDateOf.get(b)! ? 1 : -1));
  }
  return { subjects, items, itemOf, questionCount, examDateOf, ...(variantLinks.length ? { variantLinks } : {}) };
}

/** 출제빈도 순 정렬(동일 > 1회). 6단계에서 유사 군집 크기를 반영한다 */
export function byFrequency(items: Item[]): Item[] {
  return [...items].sort((a, b) => b.qids.length - a.qids.length || a.key.localeCompare(b.key));
}
