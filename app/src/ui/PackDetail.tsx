import { useEffect, useState } from 'react';
import { db, type PackRow } from '../db';
import { examLabel, packSummary, type PackSummary } from '../study';
import { formatBytes } from '../util';
import { BackButton } from './Icon';

const SOURCE: Record<string, string> = { 'public-pbt': '공개 기출(PBT)', recalled: '응시자 복원 문제', other: '기타' };

/** 문제팩 정보(조회만 — v0.7: 삭제는 설정 > 이 기기 데이터 지우기 > 문제팩 지우기 한 곳에서) */
export function PackDetail(props: { packId: string; onBack: () => void; onBackup?: () => void; toast?: (m: string) => void }) {
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

  return (
    <div className="app">
      <header className="page-head">
        <BackButton label="설정" onClick={props.onBack} />
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
            <dd>{m.exam.dateUnknown ? "시행일 모름" : m.exam.date}</dd>
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
      <p className="hint pack-hint">이 문제팩을 지우려면 설정 → 이 기기 데이터 지우기 → 문제팩 지우기에서 고르세요.</p>
    </div>
  );
}
