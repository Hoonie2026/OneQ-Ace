import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../db';
import type { Target } from '../study';
import {
  applyFilters,
  BUNDLE_MAX,
  FILTER_LABEL,
  groupByLaw,
  groupByType,
  groupByUnit,
  lawSearchUrl,
  loadSubjectView,
  QTYPE_LABEL,
  startBundle,
  type Filter,
  type QType,
  type SubjectView,
  type UnitItem,
} from '../units';

/**
 * 과목 → 단원별 / 유형별(ADR 021 4절, 앱 C3). 화면 선택은 "과목 → 단원별/유형별" 두 번까지.
 * - 단원별: 주요항목 머리글 아래 세부항목마다 [풀기 n] + 마지막에 "미정"(풀면서 단원을 고르면 옮겨 감)
 * - 유형별: [계산 정복] [기준·법령 몰아보기] [개념·실무] — 문항 없는 탭은 숨김. 기준·법령은 법령 이름별 묶음 + 찾아보기
 * - 필터 셋(두 보기 공통): 순서·절차만 / 빈출만 / 내가 자주 틀린 것
 */
export function SubjectDetail(props: { certCode: string; subjectKey: string; version: number; onSolve: (t: Target) => void; toast: (m: string) => void }) {
  const [v, setV] = useState<SubjectView | null>(null);
  const [tab, setTab] = useState<'unit' | 'type'>('unit');
  const [qtype, setQtype] = useState<QType>('calc');
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadSubjectView(props.certCode, props.subjectKey).then((x) => {
      setV(x);
      if (x && !x.units.length) setTab('type');
      if (x) {
        const t = groupByType(x.items);
        const first = (['calc', 'law', 'concept'] as QType[]).find((k) => t[k].length);
        if (first) setQtype(first);
      }
    });
  }, [props.certCode, props.subjectKey, props.version]);

  const items = useMemo(() => (v ? applyFilters(v.items, filters) : []), [v, filters]);
  if (!v) return <section className="card"><p className="muted">불러오는 중…</p></section>;

  const hasClassify = v.items.some((it) => it.qtype || it.unit || it.candidates.length);
  if (!hasClassify) {
    return (
      <section className="card" data-testid="subject-detail-empty">
        <p>이 과목 문제팩에는 단원·유형 정보가 없어요.</p>
        <p className="muted">원큐합격 전처리기 v0.5 이상으로 다시 만든 문제팩을 가져오면 단원별·유형별로 풀 수 있어요. 학습 기록은 그대로 이어집니다.</p>
      </section>
    );
  }

  const go = async (label: string, its: UnitItem[]) => {
    if (busy || !its.length) return;
    setBusy(true);
    try {
      const t = await startBundle(v.certCode, v.subjectKey, `${v.subjectName} · ${label}`, its);
      if (t) props.onSolve(t);
    } catch (err) {
      props.toast(`시작하지 못했습니다: ${describeError(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (f: Filter) =>
    setFilters((cur) => {
      const n = new Set(cur);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });
  const n = (its: UnitItem[]) => Math.min(BUNDLE_MAX, its.length);
  const Row = (p: { label: string; its: UnitItem[]; sub?: string; testId?: string }) => (
    <li className="unit-row" data-testid={p.testId}>
      <span className="unit-name">
        {p.label}
        {p.sub && <small className="muted"> {p.sub}</small>}
      </span>
      <span className="unit-count muted">{p.its.length}문항</span>
      <button className="btn btn-small btn-primary" disabled={busy || !p.its.length} onClick={() => go(p.label, p.its)}>
        {p.its.length ? `풀기 ${n(p.its)}` : '없음'}
      </button>
    </li>
  );

  const types = groupByType(items);
  const visibleTypes = (['calc', 'law', 'concept'] as QType[]).filter((k) => groupByType(v.items)[k].length);
  const { groups, undecided } = groupByUnit(v, items);

  return (
    <section className="card subj-detail" data-testid="subject-detail">
      <h2 className="subj-detail-title">{v.subjectName}</h2>
      <div className="tabs" role="tablist">
        {v.units.length > 0 && (
          <button role="tab" aria-selected={tab === 'unit'} className={`tab-btn${tab === 'unit' ? ' on' : ''}`} onClick={() => setTab('unit')} data-testid="tab-unit">
            단원별
          </button>
        )}
        <button role="tab" aria-selected={tab === 'type'} className={`tab-btn${tab === 'type' ? ' on' : ''}`} onClick={() => setTab('type')} data-testid="tab-type">
          유형별
        </button>
      </div>
      <div className="chips" aria-label="필터">
        {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
          <button key={f} className={`chip-btn${filters.has(f) ? ' on' : ''}`} aria-pressed={filters.has(f)} onClick={() => toggle(f)} data-testid={`filter-${f}`}>
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {tab === 'unit' && (
        <div data-testid="unit-list">
          {groups.map((g) => (
            <div key={g.major} className="unit-group">
              <h3 className="unit-major">{g.major}</h3>
              <ul className="unit-rows">
                {g.units.map((u) => (
                  <Row key={u.def.id} label={u.def.name} its={u.items} testId={`unit-${u.def.id}`} />
                ))}
              </ul>
            </div>
          ))}
          <div className="unit-group">
            <h3 className="unit-major">미정</h3>
            <ul className="unit-rows">
              <Row label="단원 미정" its={undecided} sub="풀고 나서 단원을 고르면 그 단원으로 옮겨 가요" testId="unit-undecided" />
            </ul>
          </div>
        </div>
      )}

      {tab === 'type' && (
        <div data-testid="type-list">
          <div className="tabs tabs-small" role="tablist">
            {visibleTypes.map((k) => (
              <button key={k} role="tab" aria-selected={qtype === k} className={`tab-btn${qtype === k ? ' on' : ''}`} onClick={() => setQtype(k)} data-testid={`qtype-${k}`}>
                {QTYPE_LABEL[k]}
              </button>
            ))}
          </div>
          <ul className="unit-rows">
            <Row label={QTYPE_LABEL[qtype]} its={types[qtype]} testId="type-all" />
          </ul>
          {qtype === 'law' && types.law.length > 0 && (
            <>
              <p className="muted law-note">출제 당시 기준의 정답이에요. 법령·기준이 개정됐을 수 있으니 묶음마다 현행 법령을 한 번에 확인하세요.</p>
              <ul className="unit-rows">
                {groupByLaw(types.law).map((g) => (
                  <li key={g.law} className="unit-row">
                    <span className="unit-name">{g.law}</span>
                    <span className="unit-count muted">{g.items.length}문항</span>
                    <a className="btn btn-small" href={lawSearchUrl(g.law)} target="_blank" rel="noopener noreferrer">
                      현행 법령 찾아보기
                    </a>
                    <button className="btn btn-small btn-primary" disabled={busy} onClick={() => go(g.law, g.items)}>
                      풀기 {n(g.items)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <p className="muted bundle-tip">한 묶음은 최대 {BUNDLE_MAX}문항 — 안 푼 문항, 자주 틀린 문항, 여러 번 나온 문항 순으로 냅니다. 몰아 풀기로 익힌 뒤에는 시스템 추천(섞어 풀기)으로 실전 감각을 기르세요.</p>
    </section>
  );
}
