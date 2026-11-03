import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
/* The only stylesheet. `styles.css` was loaded before this one for the whole
   migration so a utility could beat the global rule it was replacing; with
   nothing left in it to beat, the file is gone and its palette lives in
   `app.css`'s `@layer base`. */
import './app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
