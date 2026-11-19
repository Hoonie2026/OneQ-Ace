import { useEffect, useState } from 'react';
import { isSlow, MANY_FILES, PHASE_TEXT, progressRatio, SLOW_MESSAGE, type ImportProgress } from '../importFlow';

/** 문제팩 가져오기 진행 창(v0.10.7). 가져오는 동안 화면을 덮어 다른 조작을 막는다 */
export function ImportProgressView(props: { p: ImportProgress; onStop: () => void }) {
  const { p } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pct = Math.round(progressRatio(p) * 100);
  const slow = isSlow(p, now);
  const sec = Math.max(0, Math.round((now - p.startedAt) / 1000));
  const cur = Math.min(p.total, p.done + 1);
  return (
    <div className="modal-back imp-back" role="dialog" aria-modal="true" aria-labelledby="imp-title" data-testid="import-progress">
      <section className="modal imp">
        <h2 id="imp-title">문제팩 가져오는 중</h2>
        <p className="imp-count">
          <b data-testid="import-count">
            {cur} / {p.total}
          </b>
          <span className="imp-time">{sec}초</span>
        </p>
        <div className="imp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="가져오기 진행률">
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="imp-file">
          {p.name}
          <br />
          <span className="imp-phase">{p.stopping ? '이 파일까지만 가져오고 멈춥니다…' : PHASE_TEXT[p.phase] + '…'}</span>
        </p>
        {p.total > MANY_FILES && !slow && <p className="imp-note">파일이 많아 몇 분 걸릴 수 있습니다. 화면을 끄거나 다른 앱으로 옮기지 마세요.</p>}
        {slow && (
          <div className="imp-slow" role="alert" data-testid="import-slow">
            <b>시간이 오래 걸리고 있습니다</b>
            <p>{SLOW_MESSAGE}</p>
          </div>
        )}
        <button className="btn btn-block" onClick={props.onStop} disabled={p.stopping} data-testid="import-stop">
          {p.stopping ? '멈추는 중…' : '그만 가져오기'}
        </button>
      </section>
    </div>
  );
}
