import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { AuthLinkPage } from './AuthLinkPage';
import './styles.css';

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Root container is missing');
}

function renderConsole(root: Root) {
  const { pathname } = window.location;
  const kind = pathname === '/auth/verify' ? 'verify' : pathname === '/auth/reset' ? 'reset' : null;
  if (!kind) {
    root.render(<StrictMode><App /></StrictMode>);
    return;
  }

  let linkGeneration = 0;
  const renderLink = () => {
    const generation = ++linkGeneration;
    const { hash } = window.location;
    // Remove the fragment before rendering or requesting anything for the email action.
    window.history.replaceState(null, '', pathname);
    const token = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null;
    function returnToSignIn(notice?: string) {
      if (generation !== linkGeneration) return;
      window.removeEventListener('hashchange', renderLink);
      window.history.replaceState(null, '', '/');
      root.render(<StrictMode><App signIn={{ notice }} /></StrictMode>);
    }
    root.render(<StrictMode><AuthLinkPage key={generation} kind={kind} initialToken={token} onSignIn={returnToSignIn} /></StrictMode>);
  };
  window.addEventListener('hashchange', renderLink);
  renderLink();
}

renderConsole(createRoot(root));
