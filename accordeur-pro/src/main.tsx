import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { AppLabo } from './AppLabo';

// ?labo : ancien écran de validation (cadran, enregistrement WAV + journal)
const labo = new URLSearchParams(location.search).has('labo');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {labo ? <AppLabo /> : <App />}
  </StrictMode>,
);
