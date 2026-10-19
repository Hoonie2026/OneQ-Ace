import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'; // Pretendard(OFL) — 아이폰·안드로이드 같은 글꼴(v0.9.0)
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
