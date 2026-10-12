import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '@loam/theme-web';
import { ToastProvider } from '@loam/ui-web';
import { App } from './App';

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => applyTheme(document.documentElement, { mode: dark.matches ? 'Dark' : 'Light' }, { web: true });
apply();
dark.addEventListener('change', apply);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
