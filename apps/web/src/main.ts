// SPDX-License-Identifier: AGPL-3.0-or-later
import { createApp } from 'vue';
import { createPinia } from 'pinia';

// Fonts and icons are bundled, never fetched from a CDN: the CSP is `'self'`, and a
// local-first OCR tool must not tell a font host when someone opens it.
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import 'material-symbols/rounded.css';
import 'vuetify/styles';
import './styles/app.css';

import App from './app.vue';
import { router } from './router';
import { vuetify } from './plugins/vuetify';
import { i18n } from './plugins/i18n';

createApp(App).use(createPinia()).use(router).use(vuetify).use(i18n).mount('#app');
