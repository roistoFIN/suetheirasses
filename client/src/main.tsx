import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initConsentDefaults } from './lib/googleConsent';
import { getStoredConsentCategories } from './stores/consentStore';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import './theme.css';

// Must run before any component mounts (and therefore before any Google script could
// ever be requested) — see googleConsent.ts's own doc comment for why this can't just
// live inside a React effect.
initConsentDefaults(getStoredConsentCategories());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </React.StrictMode>,
);
