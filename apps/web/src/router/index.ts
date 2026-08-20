// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth-store';

/**
 * Routes are lazy-loaded so the first paint — the pipelines overview — does not carry the
 * pipeline editor's ~30 form controls with it.
 *
 * History mode, matched by the server's SPA fallback, so a deep link survives a refresh.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: { name: 'pipelines' } },
  {
    path: '/pipelines',
    name: 'pipelines',
    component: () => import('../features/pipelines/views/pipelines-view.vue'),
  },
  {
    path: '/pipelines/new',
    name: 'pipeline-new',
    component: () => import('../features/pipelines/views/pipeline-editor-view.vue'),
  },
  {
    path: '/pipelines/:id',
    name: 'pipeline-detail',
    component: () => import('../features/pipelines/views/pipeline-detail-view.vue'),
    props: true,
  },
  {
    path: '/pipelines/:id/edit',
    name: 'pipeline-edit',
    component: () => import('../features/pipelines/views/pipeline-editor-view.vue'),
    props: true,
  },
  {
    path: '/jobs',
    name: 'jobs',
    component: () => import('../features/jobs/views/jobs-view.vue'),
  },
  {
    path: '/system',
    name: 'system',
    component: () => import('../features/system/views/system-view.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../features/settings/views/settings-view.vue'),
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../features/auth/views/login-view.vue'),
    meta: { public: true },
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'pipelines' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * Warm the other route chunks once the first screen is up.
 *
 * Every route is `() => import(...)`, so the first visit to each one fetches its chunk and the
 * view is briefly empty — the flash users see once per screen, never again. Eager imports
 * would remove it by making everyone download the pipeline editor's 37 kB before the first
 * paint, which is the trade the lazy loading was there to avoid.
 *
 * Fetching them during idle time instead keeps the small first paint *and* makes every later
 * navigation instant. `requestIdleCallback` yields to anything the browser would rather be
 * doing; the timeout stops it waiting forever on a busy machine, and the setTimeout branch
 * covers Safari, which still lacks it.
 */
function prefetchRouteChunks(): void {
  const load = (): void => {
    for (const route of routes) {
      const component = route.component;
      // Only the lazy ones: a resolved component is already in memory.
      if (typeof component === 'function') {
        void (component as () => Promise<unknown>)().catch(() => {
          // A failed prefetch is not an error worth surfacing — navigating there will retry
          // and report properly if it still fails.
        });
      }
    }
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(load, { timeout: 2000 });
  } else {
    setTimeout(load, 1000);
  }
}

// After the first navigation resolves, so prefetching never competes with the first paint.
void router.isReady().then(prefetchRouteChunks);

/**
 * Keep protected screens behind the login.
 *
 * A guard rather than a check inside each view: a route added later is protected by default,
 * and forgetting to opt in is not a way to leak. This is convenience and correctness for the
 * UI only -- the server enforces the same rule on every request regardless of what the
 * browser believes.
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // One status call for the session, not one per navigation.
  if (!auth.checked) await auth.check();

  if (to.meta.public === true) {
    // Nothing to sign in to, or already signed in: the login screen would be a dead end.
    return auth.mustSignIn ? true : { name: 'pipelines' };
  }

  if (auth.mustSignIn) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }

  return true;
});
