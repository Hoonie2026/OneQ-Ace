import { useEffect, useState } from 'react';
import type { QuestionRow } from '../db';
import { pickUnit, unitAsk, type UnitDef } from '../units';

/**
 * 답한 뒤 "이 문제 단원은?"(ADR 021 4.5, 사용자 결정 2026-10-24): 단원 미정 문항에만, 자동 판정 후보 3개 + [모르겠음].
 * 한 문항(같은 내용 묶음)에 한 번만 묻고, 건너뛰어도 그만. 고른 단원은 이 기기의 "내가 고른 단원"(설정에서 끌 수 있음).
 */
export function UnitAsk(props: { certCode: string; q: QuestionRow }) {
  const [ask, setAsk] = useState<{ itemKey: string; options: UnitDef[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    setAsk(null);
    setDone(null);
    unitAsk(props.certCode, props.q).then(setAsk).catch(() => setAsk(null));
  }, [props.certCode, props.q.qid]);

  if (done) return <p className="unit-ask-done muted" data-testid="unit-ask-done">{done}</p>;
  if (!ask) return null;
  const choose = async (u: UnitDef | null) => {
    await pickUnit(props.certCode, ask.itemKey, u?.id ?? null);
    setDone(u ? `단원: ${u.name}(으)로 정리했어요` : '다음엔 묻지 않을게요');
  };
  return (
    <div className="unit-ask" data-testid="unit-ask">
      <span className="unit-ask-q">이 문제 단원은?</span>
      <div className="chips">
        {ask.options.map((u) => (
          <button key={u.id} className="chip-btn" onClick={() => choose(u)} title={u.major}>
            {u.name}
          </button>
        ))}
        <button className="chip-btn ghost" onClick={() => choose(null)}>
          모르겠음
        </button>
      </div>
    </div>
  );
}
