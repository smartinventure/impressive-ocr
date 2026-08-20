// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

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
  { path: '/:pathMatch(.*)*', redirect: { name: 'pipelines' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
