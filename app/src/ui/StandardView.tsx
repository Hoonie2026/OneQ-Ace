import { useEffect, useState } from 'react';
import { db } from '../db';
import type { PackManifest } from '../pack/validate';

/**
 * 출제기준 보기(사용자 2026-11-16 — 학습앱에서 선택 종목의 출제기준을 확인).
 * 이 종목 문제팩 중 가장 최근 회차(세부항목이 있는 팩 우선)의 manifest에서: 적용 기간·합격 기준·과목(문항 수)·주요항목 → 세부항목.
 * 문제팩 생성기가 문제를 이 출제기준 과목으로 정리해 넣었으므로 앱의 과목·모의고사도 이 기준을 따른다.
 */
export interface StandardInfo {
  certName: string;
  period?: { from: string; to: string };
  version?: string;
  passRule: PackManifest['passRule'];
  subjects: { no: number; name: string; count: number; isLaw: boolean; majors: { name: string; items: string[] }[] }[];
}

export function standardOf(manifests: PackManifest[]): StandardInfo | null {
  if (!manifests.length) return null;
  const hasUnits = (m: PackManifest) => m.subjects.some((s) => s.units && s.units.length > 0);
  const best = [...manifests].sort((a, b) => Number(hasUnits(b)) - Number(hasUnits(a)) || b.exam.date.localeCompare(a.exam.date))[0];
  return {
    certName: best.cert.name,
    period: best.standard?.period,
    version: best.standard?.version,
    passRule: best.passRule,
    subjects: best.subjects.map((s) => {
      const majors: { name: string; items: string[] }[] = [];
      for (const u of s.units ?? []) {
        let m = majors.find((x) => x.name === u.major);
        if (!m) majors.push((m = { name: u.major, items: [] }));
        m.items.push(u.name);
      }
      return { no: s.no, name: s.name, count: s.examCount ?? s.count, isLaw: s.isLaw, majors };
    }),
  };
}

const dot = (d: string) => d.replace(/-/g, '.');

/** Q-Net 과목명은 띄어쓰기가 없다('콘크리트재료및배합') — '및'·쉼표 앞뒤만 띄워 읽기 쉽게(뜻은 그대로) */
export const spaced = (name: string) =>
  name
    .replace(/\s*및\s*/g, ' 및 ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** 적용 기간 상태 — 오늘 기준 */
function periodState(p?: { from: string; to: string }, today = new Date().toISOString().slice(0, 10)) {
  if (!p) return null;
  if (today < p.from) return { cls: 'soon', text: '적용 예정' };
  if (today > p.to) return { cls: 'old', text: '기간 지남' };
  return { cls: 'now', text: '적용 중' };
}

/**
 * 출제기준 화면(v0.19.1 디자인 다듬기, 사용자 2026-11-18 '상용앱 수준'):
 * 위 요약 카드(Q-Net 출제기준 · 종목 · 적용 기간+상태) + 숫자 타일 셋(과목·문항·합격 기준) →
 * '과목별 출제 범위' 한 묶음 목록(과목마다 번호·이름·주요/세부항목 수·문항 수 알약, 눌러 펼침, 모두 펼치기) →
 * 펼치면 주요항목은 번호 달린 세로 줄, 세부항목은 칩.
 */
export function StandardView(props: { certCode: string }) {
  const [info, setInfo] = useState<StandardInfo | null | undefined>(undefined);
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => {
    db.packs
      .toArray()
      .then((rows) => {
        const st = standardOf(rows.map((r) => r.manifest).filter((m) => m.cert.code === props.certCode));
        setInfo(st);
        if (st && st.subjects.length <= 2) setOpen(new Set(st.subjects.map((x) => x.no)));
      })
      .catch(() => setInfo(null));
  }, [props.certCode]);

  if (info === undefined) return null;
  if (!info)
    return (
      <section className="card">
        <p className="hint">이 종목의 문제팩이 없습니다.</p>
      </section>
    );
  const total = info.subjects.reduce((a, s) => a + s.count, 0);
  const noUnits = info.subjects.every((s) => s.majors.length === 0);
  const st = periodState(info.period);
  const allOpen = info.subjects.every((s) => open.has(s.no));
  const toggle = (no: number) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(no)) n.delete(no);
      else n.add(no);
      return n;
    });

  return (
    <div className="std-view" data-testid="standard-view">
      <section className="card std-hero">
        <p className="std-eyebrow">Q-Net 출제기준 · 필기</p>
        <h2 className="std-title">{info.certName}</h2>
        <p className="std-period">
          <span>적용 기간</span>
          <b>{info.period ? `${dot(info.period.from)} – ${dot(info.period.to)}` : info.version ? `${info.version} 기준` : '기록 없음'}</b>
          {st && <em className={`std-state ${st.cls}`}>{st.text}</em>}
        </p>
        <div className="std-stats" role="list">
          <div role="listitem">
            <b>{info.subjects.length}</b>
            <span>과목</span>
          </div>
          <div role="listitem">
            <b>{total}</b>
            <span>문항</span>
          </div>
          <div role="listitem" aria-label={`합격 기준: 과목마다 ${info.passRule.subjectMin}점 이상, 전 과목 평균 ${info.passRule.avgMin}점 이상`}>
            <b>
              {info.passRule.avgMin}
              <small>점</small>
            </b>
            <span>합격 기준</span>
          </div>
        </div>
        <p className="std-rule">
          과목마다 <b>{info.passRule.subjectMin}점 이상</b>, 전 과목 평균 <b>{info.passRule.avgMin}점 이상</b>이면 합격
        </p>
      </section>

      <div className="std-section-head">
        <h3>과목별 출제 범위</h3>
        {!noUnits && (
          <button className="link-btn small" onClick={() => setOpen(allOpen ? new Set() : new Set(info.subjects.map((x) => x.no)))} data-testid="std-toggle-all">
            {allOpen ? '모두 접기' : '모두 펼치기'}
          </button>
        )}
      </div>

      <section className="card std-list">
        {info.subjects.map((s) => {
          const isOpen = open.has(s.no);
          const items = s.majors.reduce((a, m) => a + m.items.length, 0);
          return (
            <div key={s.no} className={`std-subject${isOpen ? ' open' : ''}`} data-testid="standard-subject">
              <button className="std-row" onClick={() => toggle(s.no)} aria-expanded={isOpen} disabled={!s.majors.length}>
                <span className="std-no">{s.no}</span>
                <span className="std-body">
                  <span className="std-name">
                    {spaced(s.name)}
                    {s.isLaw && <em className="std-tag">법규</em>}
                  </span>
                  <small className="std-meta">{s.majors.length ? `주요항목 ${s.majors.length} · 세부항목 ${items}` : '세부 항목 없음'}</small>
                </span>
                <span className="std-count">{s.count}문항</span>
                {s.majors.length > 0 && <span className="std-chev" aria-hidden="true" />}
              </button>
              {isOpen && s.majors.length > 0 && (
                <ol className="std-majors">
                  {s.majors.map((m, i) => (
                    <li key={m.name}>
                      <span className="std-mno" aria-hidden="true">
                        {i + 1}
                      </span>
                      <div>
                        <b>{m.name}</b>
                        <ul className="std-chips">
                          {m.items.map((it) => (
                            <li key={it}>{it}</li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </section>
      <p className="std-foot">
        {noUnits
          ? '주요항목·세부항목은 최신 문제팩 생성기로 만든 문제팩에서 보입니다.'
          : '문제팩을 만들 때 Q-Net에서 받은 출제기준입니다. 학습앱의 과목·모의고사는 이 기준을 따릅니다.'}
      </p>
    </div>
  );
}
