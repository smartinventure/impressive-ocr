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
import { setUnauthorizedHandler } from './api/client';
import { useAuthStore } from './stores/auth-store';
import { router } from './router';
import { vuetify } from './plugins/vuetify';
import { i18n } from './plugins/i18n';

const app = createApp(App).use(createPinia()).use(router).use(vuetify).use(i18n);

// Any 401, from any request, drops the app back to the login screen. Wired here rather than
// inside the client so the client keeps no dependency on the router or on Pinia.
setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  auth.onSessionLost();
  if (auth.mustSignIn && router.currentRoute.value.name !== 'login') {
    void router.replace({ name: 'login' });
  }
});

app.mount('#app');
