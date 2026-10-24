/**
 * 과목별 학습 = 단원별 + 유형별(ADR 021 4절, 앱 C3).
 *
 * - 단원 = 출제기준 세부항목. 팩 v0.5부터 문항 `unit`(확신 있는 것만)·`unitCandidates`(미정 문항의 후보 3개), 과목 `units`.
 * - 학습 단위는 엔진과 같은 **동일 문항 묶음(item)** — 같은 문제가 여러 회차에 나와도 한 번만 낸다(대표 = 가장 최근 회차).
 * - 묶음의 단원: 묶음 안 문항 중 팩이 정한 단원 → 없으면 **내가 고른 단원**(이 기기, 설정 `unitPicks:종목` — 백업에 포함) → 없으면 미정.
 * - 유형 탭: 계산 정복(calc) / 기준·법령(law) / 개념·실무(concept). 필터: 순서·절차만 / 빈출만(여러 회차) / 내가 자주 틀린 것.
 * - 단원별 화면은 모든 과목에 켠다(사용자 2026-10-24 "이어서 진행" — 기준선 미정이라 넓게 켜고, 정확도 낮은 몫은 미정 + 학습 중 고르기로 흡수).
 */
import { db as defaultDb, getSetting, safeWrite, type OneQDB, type QuestionRow } from './db';
import { subjectKey, type Item } from './engine/items';
import { loadEngine } from './engine/load';
import { createSetRun, type Target } from './study';

export type QType = 'calc' | 'law' | 'concept';
export const QTYPE_LABEL: Record<QType, string> = { calc: '계산 정복', law: '기준·법령 몰아보기', concept: '개념·실무' };
export type Filter = 'sequence' | 'frequent' | 'wrong';
export const FILTER_LABEL: Record<Filter, string> = { sequence: '순서·절차만', frequent: '빈출만', wrong: '내가 자주 틀린 것' };

export interface UnitDef {
  id: string;
  major: string;
  name: string;
}

export interface UnitItem {
  key: string; // 동일 문항 묶음 키
  qid: string; // 대표 문항(가장 최근 회차)
  qids: string[];
  unit: string | null; // 팩이 정했거나 내가 고른 단원
  picked: boolean; // 내가 고른 단원인가
  candidates: string[]; // 미정일 때 후보
  qtype: QType | null;
  sequence: boolean;
  lawRefs: string[];
  frequent: boolean; // 2회 이상 출제
  wrongOften: boolean; // 최근 풀이 중 틀림·모름이 2번 이상(또는 마지막이 틀림)
  solved: number; // 푼 횟수
}

export interface SubjectView {
  certCode: string;
  subjectKey: string;
  subjectName: string;
  units: UnitDef[]; // 출제기준 세부항목(없으면 단원별 탭 숨김)
  items: UnitItem[];
}

const pickKey = (certCode: string) => `unitPicks:${certCode}`;

export async function getUnitPicks(certCode: string, d: OneQDB = defaultDb): Promise<Record<string, string>> {
  return getSetting<Record<string, string>>(pickKey(certCode), {}, d);
}

/**
 * 미정 문항에서 학습자가 고른 단원을 저장(ADR 021 4.5) — 동일 문항 묶음 키에 붙이므로 다른 회차의 같은 문제에도 함께 적용.
 * unit=null이면 "모르겠음"(다시 묻지 않음 — 값 '?')
 */
export async function pickUnit(certCode: string, itemKey: string, unit: string | null, d: OneQDB = defaultDb): Promise<void> {
  const cur = await getUnitPicks(certCode, d);
  cur[itemKey] = unit ?? '?';
  await safeWrite('단원 고르기 저장', () => d.settings.put({ key: pickKey(certCode), value: cur, updatedAt: Date.now() }));
}

export const ASK_UNIT_SETTING = 'askUnit';
export async function askUnitEnabled(d: OneQDB = defaultDb): Promise<boolean> {
  return getSetting<boolean>(ASK_UNIT_SETTING, true, d);
}

/** 과목의 단원 목록: 가장 최근 팩 manifest의 그 과목 units(출제기준 세부항목) */
async function unitDefs(certCode: string, sk: string, d: OneQDB): Promise<{ name: string; units: UnitDef[] }> {
  const packs = (await d.packs.toArray()).filter((p) => p.manifest.cert.code === certCode);
  packs.sort((a, b) => (a.manifest.exam.date < b.manifest.exam.date ? 1 : -1));
  for (const p of packs) {
    const s = p.manifest.subjects.find((x) => subjectKey(x.name) === sk);
    if (s?.units?.length) return { name: s.name, units: s.units };
  }
  const any = packs.flatMap((p) => p.manifest.subjects).find((x) => subjectKey(x.name) === sk);
  return { name: any?.name ?? '과목', units: [] };
}

function itemOfRows(it: Item, rows: Map<string, QuestionRow>, picks: Record<string, string>, wrongCount: Map<string, number>, lastWrong: Set<string>, solvedCount: Map<string, number>): UnitItem {
  const qs = it.qids.map((q) => rows.get(q)).filter((q): q is QuestionRow => !!q);
  const withUnit = qs.find((q) => q.unit);
  const pick = picks[it.key];
  const unit = withUnit?.unit ?? (pick && pick !== '?' ? pick : null);
  const cands = withUnit ? [] : [...new Set(qs.flatMap((q) => q.unitCandidates ?? []))].slice(0, 3);
  const qtype = (qs.find((q) => q.qtype)?.qtype as QType | undefined) ?? null;
  const wrong = it.qids.reduce((n, q) => n + (wrongCount.get(q) ?? 0), 0);
  return {
    key: it.key,
    qid: it.qids[0],
    qids: it.qids,
    unit,
    picked: !withUnit && !!unit,
    candidates: pick ? [] : cands, // 이미 고름(또는 "모르겠음")이면 다시 묻지 않음
    qtype,
    sequence: qs.some((q) => q.sequence),
    lawRefs: [...new Set(qs.flatMap((q) => q.lawRefs ?? []))],
    frequent: it.qids.length >= 2,
    wrongOften: wrong >= 2 || it.qids.some((q) => lastWrong.has(q)),
    solved: it.qids.reduce((n, q) => n + (solvedCount.get(q) ?? 0), 0),
  };
}

export async function loadSubjectView(certCode: string, sk: string, d: OneQDB = defaultDb): Promise<SubjectView | null> {
  const ctx = await loadEngine(certCode, d);
  if (!ctx) return null;
  const items = ctx.bank.items.filter((it) => it.subjectKey === sk);
  const qids = items.flatMap((it) => it.qids);
  const rows = new Map((await d.questions.where('qid').anyOf(qids).toArray()).map((q) => [q.qid, q]));
  const picks = await getUnitPicks(certCode, d);
  // 개인 기록: 틀림·모름 횟수, 마지막 풀이가 틀림인 문항(모의고사 포함 — 실력 신호라서)
  const wrongCount = new Map<string, number>();
  const solvedCount = new Map<string, number>();
  const last = new Map<string, { ts: number; correct: boolean }>();
  for (const a of ctx.attempts) {
    solvedCount.set(a.qid, (solvedCount.get(a.qid) ?? 0) + 1);
    if (!a.correct) wrongCount.set(a.qid, (wrongCount.get(a.qid) ?? 0) + 1);
    const l = last.get(a.qid);
    if (!l || a.ts > l.ts) last.set(a.qid, { ts: a.ts, correct: a.correct });
  }
  const lastWrong = new Set([...last].filter(([, v]) => !v.correct).map(([q]) => q));
  const defs = await unitDefs(certCode, sk, d);
  const name = ctx.bank.subjects.find((s) => s.key === sk)?.name ?? defs.name;
  return { certCode, subjectKey: sk, subjectName: name, units: defs.units, items: items.map((it) => itemOfRows(it, rows, picks, wrongCount, lastWrong, solvedCount)) };
}

export function applyFilters(items: UnitItem[], filters: Set<Filter>): UnitItem[] {
  return items.filter((it) => (!filters.has('sequence') || it.sequence) && (!filters.has('frequent') || it.frequent) && (!filters.has('wrong') || it.wrongOften));
}

/** 단원별 묶음: 주요항목(머리글) → 세부항목 → 문항 묶음, 마지막에 미정 */
export interface UnitGroup {
  major: string;
  units: { def: UnitDef; items: UnitItem[] }[];
}
export function groupByUnit(v: SubjectView, items: UnitItem[]): { groups: UnitGroup[]; undecided: UnitItem[] } {
  const byUnit = new Map<string, UnitItem[]>();
  const undecided: UnitItem[] = [];
  const known = new Set(v.units.map((u) => u.id));
  for (const it of items) {
    if (it.unit && known.has(it.unit)) byUnit.set(it.unit, [...(byUnit.get(it.unit) ?? []), it]);
    else undecided.push(it);
  }
  const groups: UnitGroup[] = [];
  for (const u of v.units) {
    let g = groups.find((x) => x.major === u.major);
    if (!g) groups.push((g = { major: u.major, units: [] }));
    g.units.push({ def: u, items: byUnit.get(u.id) ?? [] });
  }
  return { groups, undecided };
}

export function groupByType(items: UnitItem[]): Record<QType, UnitItem[]> {
  const out: Record<QType, UnitItem[]> = { calc: [], law: [], concept: [] };
  for (const it of items) out[it.qtype ?? 'concept'].push(it);
  return out;
}

/** 법령 묶음(ADR 021 4.3): 법령 이름별 — 묶음 단위로 [현행 법령 찾아보기] */
export function groupByLaw(items: UnitItem[]): { law: string; items: UnitItem[] }[] {
  const m = new Map<string, UnitItem[]>();
  for (const it of items) {
    const k = it.lawRefs[0] ?? '기준·법령(이름 없음)';
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m].map(([law, its]) => ({ law, items: its })).sort((a, b) => b.items.length - a.items.length);
}

export function lawSearchUrl(law: string): string {
  return `https://www.law.go.kr/LSW/lsSc.do?query=${encodeURIComponent(law)}`;
}

/** 묶음 하나로 풀 문항 순서: 안 푼 것 → 자주 틀린 것 → 나머지, 같은 안에서는 빈출 먼저. 한 번에 최대 BUNDLE_MAX */
export const BUNDLE_MAX = 20;
export function bundleOrder(items: UnitItem[]): UnitItem[] {
  const rank = (it: UnitItem) => (it.solved === 0 ? 0 : it.wrongOften ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || b.qids.length - a.qids.length || a.key.localeCompare(b.key)).slice(0, BUNDLE_MAX);
}

/** 묶음 학습 시작 — 오늘 학습과 같은 풀이 묶음(기록·기억은 엔진에 그대로 쌓임). 끝나면 "섞어 풀기" 안내(run.bundle) */
export async function startBundle(certCode: string, sk: string, label: string, items: UnitItem[], now = Date.now(), d: OneQDB = defaultDb): Promise<Target | null> {
  const pick = bundleOrder(items);
  if (!pick.length) return null;
  const run = await createSetRun(certCode, 'today', label, pick.map((it) => it.qid), { now, subjectKey: sk }, d);
  await safeWrite('묶음 표시', () => d.runs.update(run.sessionId, { bundle: label }));
  return { kind: 'set', sessionId: run.sessionId };
}

/** 풀이 화면의 "이 문제 단원은?"(미정 문항만, ADR 021 4.5) — 물을 것이 없으면 null */
export async function unitAsk(certCode: string, q: QuestionRow, d: OneQDB = defaultDb): Promise<{ itemKey: string; options: UnitDef[] } | null> {
  if (q.unit || !q.unitCandidates?.length || !(await askUnitEnabled(d))) return null;
  const pack = await d.packs.get(q.packId);
  const subj = pack?.manifest.subjects.find((s) => s.no === q.subjectNo);
  if (!subj?.units?.length) return null;
  const ctx = await loadEngine(certCode, d);
  const it = ctx?.bank.itemOf.get(q.qid);
  if (!it) return null;
  const picks = await getUnitPicks(certCode, d);
  if (picks[it.key]) return null;
  // 같은 묶음의 다른 회차 문항이 단원을 가졌으면 묻지 않음
  const others = await d.questions.where('qid').anyOf(it.qids).toArray();
  if (others.some((o) => o.unit)) return null;
  const options = q.unitCandidates.map((id) => subj.units!.find((u) => u.id === id)).filter((u): u is UnitDef => !!u);
  return options.length ? { itemKey: it.key, options } : null;
}
