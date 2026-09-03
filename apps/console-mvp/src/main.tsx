import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Root container is missing');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
