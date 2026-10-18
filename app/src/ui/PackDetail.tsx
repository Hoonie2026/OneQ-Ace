import { useEffect, useState } from 'react';
import { db, type PackRow } from '../db';
import { deletePack } from '../pack/import';
import { examLabel, packSummary, type PackSummary } from '../study';
import { formatBytes } from '../util';

const SOURCE: Record<string, string> = { 'public-pbt': '공개 기출(PBT)', recalled: '응시자 복원 문제', other: '기타' };

export function PackDetail(props: { packId: string; onBack: () => void; onBackup: () => void; toast: (m: string) => void }) {
  const [pack, setPack] = useState<PackRow | null>(null);
  const [prog, setProg] = useState<PackSummary | null>(null);

  useEffect(() => {
    (async () => {
      const p = await db.packs.get(props.packId);
      if (!p) return props.onBack();
      setPack(p);
      setProg(await packSummary(p));
    })();
  }, [props.packId]);

  if (!pack) return <div className="app" />;
  const m = pack.manifest;

  const remove = async () => {
    if (!window.confirm(`${examLabel(m)} 문제팩을 삭제할까요?\n풀이 기록은 지우지 않고 '매핑 대기'로 보관했다가, 같은 팩을 다시 가져오면 이어집니다.`)) return;
    if (!window.confirm('삭제하기 전에 백업해 두는 것을 권합니다. 그래도 지금 삭제할까요?')) return;
    const { parked } = await deletePack(pack.packId);
    props.toast(`삭제했습니다${parked ? ` · 기록 ${parked}건 보관` : ''}`);
    props.onBack();
  };

  return (
    <div className="app">
      <header className="page-head">
        <button className="icon-btn" onClick={props.onBack} aria-label="뒤로">
          ‹
        </button>
        <h1>
          {m.cert.name} {examLabel(m)}
        </h1>
      </header>
      <section className="card">
        <dl className="kv">
          <div>
            <dt>문항</dt>
            <dd>
              {m.questionCount}문항{prog && prog.answered > 0 ? ` · 회차로 푼 진도 ${prog.answered}/${prog.total}` : ''}
            </dd>
          </div>
          <div>
            <dt>과목</dt>
            <dd>{m.subjects.map((s) => `${s.no}. ${s.name}`).join(' / ')}</dd>
          </div>
          <div>
            <dt>시행일</dt>
            <dd>{m.exam.date}</dd>
          </div>
          <div>
            <dt>출처</dt>
            <dd>
              {SOURCE[m.source.type] ?? m.source.type}
              {m.source.origin ? ` — ${m.source.origin}` : ''}
            </dd>
          </div>
          <div>
            <dt>전처리</dt>
            <dd>
              {m.preparedBy} · {m.reviewedAt ? `검수 ${m.reviewedAt}` : '검수 전'} · v{m.packVersion}
            </dd>
          </div>
          <div>
            <dt>용량</dt>
            <dd>{formatBytes(pack.bytes)}</dd>
          </div>
          <div>
            <dt>가져온 날</dt>
            <dd>{new Date(pack.importedAt).toLocaleString('ko-KR')}</dd>
          </div>
        </dl>
      </section>
      <section className="actions">
        <button className="btn btn-block" onClick={props.onBackup}>
          먼저 백업하기
        </button>
        <button className="btn btn-danger btn-block" onClick={remove}>
          이 문제팩 삭제
        </button>
      </section>
    </div>
  );
}
