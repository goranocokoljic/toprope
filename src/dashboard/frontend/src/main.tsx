import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClientProvider} from '@tanstack/react-query';
import {BrowserRouter} from 'react-router-dom';

// Distinctive font pairing: Space Grotesk (display) + Inter (body), self-hosted
// via @fontsource so there is no runtime dependency on Google Fonts.
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';

import './index.css';
import {App} from './App';
import {ThemeProvider} from './theme/ThemeProvider';
import {createQueryClient} from './api/queryClient';

const queryClient = createQueryClient();

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <BrowserRouter basename="/dashboard">
                    <App />
                </BrowserRouter>
            </ThemeProvider>
        </QueryClientProvider>
    </StrictMode>,
);
