import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './install'; // 설치 이벤트(beforeinstallprompt)를 화면보다 먼저 듣기(v0.10.1)
import App from './App';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'; // Pretendard(OFL) — 아이폰·안드로이드 같은 글꼴(v0.9.0)
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
