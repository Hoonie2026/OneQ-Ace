import { useEffect, useState, type ReactNode } from 'react';
import { canPromptInstall, externalOpenUrl, justInstalled, onInstallChange, promptInstall } from '../install';
import { deviceEnv, deviceNoun, type DeviceEnv } from '../util';

/**
 * 기기별 설치 안내(v0.10.1 — 실기기 Y6·추가 검토). 권장 경로를 기기마다 하나로:
 * 안드로이드 = Chrome에서 [앱 설치], 아이폰·아이패드 = Safari에서 공유 → 홈 화면에 추가, PC = Chrome·Edge에서 설치(선택).
 * 카카오톡·네이버 앱 안에서 열리면 설치가 안 되고 기록도 따로 저장되므로 먼저 바깥 브라우저로 보낸다.
 */
interface Guide {
  title: string;
  lead?: string;
  action?: { label: string; run: () => void; testId: string };
  steps: ReactNode[];
  note?: string;
  /** 나중에(7일 숨김) 단추를 보일지 — 앱 안 브라우저·아이폰 Safari 탭은 기록이 따로라 숨기지 않음 */
  dismissible: boolean;
}

function guideFor(env: DeviceEnv, canPrompt: boolean, url: string, copy: () => void, install: () => void): Guide {
  const dev = deviceNoun(env);
  if (env.inApp) {
    const appName = env.inApp === 'kakao' ? '카카오톡' : env.inApp === 'naver' ? '네이버 앱' : '다른 앱';
    const target = env.os === 'ios' ? 'Safari' : 'Chrome';
    const ext = externalOpenUrl(env.inApp, env.os, url);
    return {
      title: `${appName} 안에서 열렸습니다`,
      lead: `여기서는 설치가 안 되고 기록도 따로 저장됩니다. ${target}에서 열어 주세요.`,
      action: ext ? { label: `${target}로 열기`, run: () => (window.location.href = ext), testId: 'open-external' } : { label: '주소 복사', run: copy, testId: 'copy-url' },
      steps:
        env.os === 'ios'
          ? ['화면 아래 공유 단추(□↑) 또는 ··· 를 누릅니다', `「Safari로 열기」를 고릅니다`, '안 보이면 [주소 복사] → Safari 주소창에 붙여넣기']
          : ['화면의 ⋮ (점 세 개)를 누릅니다', '「다른 브라우저로 열기」 → Chrome을 고릅니다'],
      dismissible: false,
    };
  }
  if (env.os === 'ios') {
    if (env.browser !== 'Safari')
      return {
        title: 'Safari로 열어 주세요',
        lead: '아이폰·아이패드는 Safari에서 홈 화면에 추가해야 앱처럼 쓰고 기록이 오래 보존됩니다.',
        action: { label: '주소 복사', run: copy, testId: 'copy-url' },
        steps: ['[주소 복사]를 누릅니다', 'Safari를 열고 주소창에 붙여넣습니다', '열린 화면의 안내대로 홈 화면에 추가합니다'],
        dismissible: false,
      };
    return {
      title: `${dev} 홈 화면에 추가하세요`,
      steps: [
        `${env.kind === 'tablet' ? '화면 위' : '화면 아래'} 공유 단추(□↑)를 누릅니다`,
        '목록을 위로 밀어 「홈 화면에 추가」를 누릅니다',
        '오른쪽 위 「추가」를 누릅니다',
        '이제 홈 화면의 원큐합격 아이콘으로 엽니다',
      ],
      note: '이 Safari 화면과 홈 화면 앱은 기록이 따로 저장됩니다. 문제팩은 앱에서 가져오세요.',
      dismissible: false,
    };
  }
  if (env.kind === 'pc')
    return {
      title: 'PC에 설치하면 창으로 바로 열립니다(선택)',
      lead: '설치하지 않고 이 브라우저에서 그대로 써도 됩니다. 같은 브라우저·같은 사용자 프로필로 열어야 기록이 이어집니다.',
      action: canPrompt ? { label: 'PC에 설치', run: install, testId: 'install-app' } : undefined,
      steps:
        env.browser === 'Edge'
          ? ['주소창 오른쪽의 「앱 사용 가능」 아이콘을 누르거나, ⋯ → 앱 → 「이 사이트를 앱으로 설치」', '「설치」를 누릅니다', '바탕 화면·시작 메뉴의 원큐합격 아이콘으로 엽니다']
          : env.browser === 'Chrome' || env.browser === '웨일'
            ? ['주소창 오른쪽 끝의 설치 아이콘(모니터 모양)을 누릅니다', '「설치」를 누릅니다', '바탕 화면·시작 메뉴의 원큐합격 아이콘으로 엽니다']
            : ['Chrome 또는 Edge로 이 주소를 엽니다', '주소창 오른쪽의 설치 아이콘을 누릅니다'],
      dismissible: true,
    };
  // 안드로이드에서 Chrome이 아닌 브라우저(Firefox·Edge·웨일 등 — 기본 브라우저면 메일·메신저 링크가 여기로 열림, 실기기 Z4)
  if (env.browser !== 'Chrome' && !(canPrompt && env.browser === '삼성 인터넷')) {
    const ext = externalOpenUrl('other', 'android', url);
    return {
      title: `${dev}에서는 Chrome으로 설치하세요`,
      lead: `지금은 ${env.browser}에서 열렸습니다. 브라우저마다 기록이 따로 저장되므로 설치와 학습은 Chrome 한 곳에서 하세요.`,
      action: ext ? { label: 'Chrome으로 열기', run: () => (window.location.href = ext), testId: 'open-chrome' } : undefined,
      steps: [
        '[Chrome으로 열기]를 누릅니다(안 되면 Chrome을 열고 주소창에 이 주소를 입력)',
        'Chrome 화면의 [원큐합격 앱 설치] 또는 ⋮ → 「앱 설치」·「설치 및 바로가기 만들기 → 설치」',
        `${env.browser}에서 계속 쓰려면: 메뉴(⋮) → 「설치」 또는 「홈 화면에 추가」`,
      ],
      dismissible: true,
    };
  }
  // 안드로이드 휴대폰·태블릿(Chrome·삼성 인터넷)
  return {
    title: `${dev}에 앱으로 설치하세요`,
    lead: '설치하면 인터넷 없이도 열리고 기록이 오래 보존됩니다.',
    action: canPrompt ? { label: '원큐합격 앱 설치', run: install, testId: 'install-app' } : undefined,
    steps:
      env.browser === 'Chrome'
        ? [
            canPrompt ? '[원큐합격 앱 설치]를 누르거나, 오른쪽 위 ⋮ 를 누릅니다' : '오른쪽 위 ⋮ (점 세 개)를 누릅니다',
            '「앱 설치」 또는 「설치 및 바로가기 만들기」 → 「설치」를 고릅니다',
            '잠시 뒤 앱 목록에 원큐합격이 생깁니다. 홈 화면에 없으면 앱 목록에서 아이콘을 길게 눌러 「홈 화면에 추가」',
          ]
        : [
            canPrompt ? '[원큐합격 앱 설치]를 누릅니다' : 'Chrome으로 이 주소를 엽니다(설치가 가장 쉽습니다)',
            '설치가 끝나면 앱 목록·홈 화면의 원큐합격 아이콘으로 엽니다',
          ],
    dismissible: true,
  };
}

const HIDE_KEY = 'oneq-install-hide-until';

export function InstallGuide(props: { url: string; onCopy: () => void; compact?: boolean; testId?: string }) {
  const env = deviceEnv();
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [hidden, setHidden] = useState(() => {
    try {
      return Number(localStorage.getItem(HIDE_KEY) ?? 0) > Date.now();
    } catch {
      return false;
    }
  });
  // 설치 직후 PC Chrome·Edge는 지금 탭을 그대로 앱 창으로 옮긴다(새로 불러오지 않음) → 표시 방식이 바뀌면 카드를 숨긴다(실기기 Z5)
  const [installedNow, setInstalledNow] = useState(false);
  useEffect(() => {
    const off = onInstallChange(() => {
      setCanPrompt(canPromptInstall());
      if (justInstalled()) setInstalledNow(true);
    });
    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onMode = () => mq?.matches && setInstalledNow(true);
    mq?.addEventListener?.('change', onMode);
    return () => {
      off();
      mq?.removeEventListener?.('change', onMode);
    };
  }, []);
  // 카카오톡 안에서 처음 열리면 바로 바깥 브라우저로(카카오톡이 제공하는 주소). 실패하면 이 카드의 단추·안내
  useEffect(() => {
    if (!props.compact || env.inApp !== 'kakao') return;
    try {
      if (sessionStorage.getItem('oneq-kakao-escape')) return;
      sessionStorage.setItem('oneq-kakao-escape', '1');
    } catch {
      return;
    }
    const ext = externalOpenUrl('kakao', env.os, props.url);
    if (ext) window.location.href = ext;
  }, []);

  if (env.standalone || installedNow) return null;
  const g = guideFor(env, canPrompt, props.url, props.onCopy, () => void promptInstall());
  if (props.compact && hidden && g.dismissible) return null;

  return (
    <section className={`card guide install-guide${props.compact ? '' : ' plain'}`} data-testid={props.testId ?? 'install-guide'}>
      <h2>{g.title}</h2>
      {g.lead && <p className="hint">{g.lead}</p>}
      {g.action && (
        <button className="btn btn-primary btn-block" onClick={g.action.run} data-testid={g.action.testId}>
          {g.action.label}
        </button>
      )}
      <ol className="install-steps">
        {g.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {g.note && <p className="hint">{g.note}</p>}
      {props.compact && g.dismissible && (
        <button
          className="link-btn install-later"
          onClick={() => {
            try {
              localStorage.setItem(HIDE_KEY, String(Date.now() + 7 * 86_400_000));
            } catch {
              /* 저장이 안 되면 이번에만 숨김 */
            }
            setHidden(true);
          }}
        >
          나중에(7일 동안 숨기기)
        </button>
      )}
    </section>
  );
}
