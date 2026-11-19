import { useEffect, useState } from 'react';
import { type PackRow } from '../db';
import { ensureWrongRun, examLabel, packSummary, type PackSummary, type Target } from '../study';
import { Icon } from './Icon';

/**
 * 회차별 학습(v0.19, 사용자 2026-11-17): 시스템 추천·과목별 학습에 더해, 기출 한 회차를 처음부터 끝까지 시험지 순서대로.
 * 회차마다 한 줄 — 연도·회차, 문항 수, 지금 회독 진도·몇 회독째. 누르면 이어 풀기(다 풀었으면 성적),
 * 푼 문항이 있으면 [성적 보기], 틀리거나 모른 문항이 있으면 [오답·모름 n 다시 풀기]. 회독·성적·회독 이력은 기존 회독 기능(ADR 003) 그대로
 */
export function RoundList(props: { packs: PackRow[]; version: number; onSolve: (t: Target) => void; onResult: (t: Target) => void }) {
  const [rows, setRows] = useState<PackSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const sorted = [...props.packs].sort((a, b) => b.manifest.exam.year - a.manifest.exam.year || b.manifest.exam.round - a.manifest.exam.round);
      const out: PackSummary[] = [];
      for (const p of sorted) out.push(await packSummary(p));
      if (alive) setRows(out);
    })();
    return () => {
      alive = false;
    };
  }, [props.packs, props.version]);

  const retryWrong = async (packId: string) => {
    const run = await ensureWrongRun(packId);
    if (run) props.onSolve({ kind: 'wrong', sessionId: run.sessionId });
  };

  return (
    <section className="card subj-pick" data-testid="round-list">
      <p className="subj-ask">학습할 회차를 선택하세요</p>
      <p className="hint">한 회차를 시험지 순서대로 처음부터 끝까지 풉니다. 중간에 나가도 다음에 이어서 풀고, 다 풀면 성적·합격선을 보여 줍니다.</p>
      {!rows && <p className="muted">불러오는 중…</p>}
      <ul className="subj-rows">
        {rows?.map((r) => {
          const m = r.pack.manifest;
          const done = r.answered >= r.total && r.total > 0;
          const sub = done
            ? `${r.total}문항 · ${r.passNo}회독 다 풂 — 성적 보기`
            : r.answered > 0
              ? `${r.total}문항 · ${r.passNo}회독 ${r.answered}/${r.total} — 이어 풀기`
              : `${r.total}문항${r.passNo > 1 ? ` · ${r.passNo}회독` : ''} — 처음 풀기`;
          const target: Target = { kind: 'pass', packId: r.pack.packId };
          return (
            <li key={r.pack.packId} data-testid={`round-${r.pack.packId}`}>
              <button className="subj-row" onClick={() => (done ? props.onResult(target) : props.onSolve(target))} data-testid="round-study">
                <span className="subj-body">
                  <span className="subj-name">{examLabel(m)}</span>
                  <small className="subj-sub">{sub}</small>
                  {r.answered > 0 && !done && (
                    <span className="round-meter" aria-hidden="true">
                      <span style={{ width: `${(r.answered / r.total) * 100}%` }} />
                    </span>
                  )}
                </span>
                <Icon name="forward" size={20} className="subj-arrow" />
              </button>
              {(r.answered > 0 && !done) || r.wrongNow > 0 ? (
                <div className="round-extra">
                  {r.answered > 0 && !done && (
                    <button className="link-btn small" onClick={() => props.onResult(target)} data-testid="round-result">
                      지금까지 성적
                    </button>
                  )}
                  {r.wrongNow > 0 && (
                    <button className="link-btn small" onClick={() => retryWrong(r.pack.packId)} data-testid="round-wrong">
                      오답·모름 {r.wrongNow}문항 다시 풀기
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
