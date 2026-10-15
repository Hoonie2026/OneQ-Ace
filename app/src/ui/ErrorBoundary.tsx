import { Component, type ReactNode } from 'react';

/** 화면 하나가 오류로 멈춰도 앱 전체가 빈 화면이 되지 않게 한다. 학습 기록은 DB에 있으므로 홈으로 돌아가면 그대로다 */
export class ErrorBoundary extends Component<{ children: ReactNode; onHome: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const text = `원큐합격 ${__APP_VERSION__} 오류\n${navigator.userAgent}\n${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(0, 6).join('\n')}`;
    return (
      <div className="app">
        <section className="card crash" role="alert">
          <h2>화면을 그리다 오류가 났습니다</h2>
          <p className="hint">학습 기록은 저장돼 있습니다. 아래 내용을 복사해 개발자에게 보내 주세요.</p>
          <pre className="diag">{text}</pre>
          <div className="stack">
            <button className="btn btn-primary btn-block" onClick={this.props.onHome}>
              홈으로
            </button>
            <button className="btn btn-block" onClick={() => navigator.clipboard?.writeText(text).catch(() => undefined)}>
              오류 내용 복사
            </button>
            <button className="btn btn-block" onClick={() => window.location.reload()}>
              앱 다시 불러오기
            </button>
          </div>
        </section>
      </div>
    );
  }
}
