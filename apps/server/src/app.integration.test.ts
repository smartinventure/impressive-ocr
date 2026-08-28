// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from './app';

/**
 * End-to-end tests through the real HTTP stack — routing, zod validation, the error handler,
 * the services and a real SQLite database.
 *
 * Driven with Fastify's `inject()` rather than a bound socket: no port to clash with an
 * existing install, no teardown race, and it runs identically in CI.
 */

let app: AppHandle;
let root: string;
let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-app-'));
  inputDir = join(root, 'in');
  outputDir = join(root, 'out');
  await mkdir(inputDir, { recursive: true });

  app = await createApp({
    dataDir: join(root, 'data'),
    webRoot: undefined,
    pretty: false,
    logLevel: 'silent',
  });
});

afterEach(async () => {
  await app.shutdown();
});

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.http.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() };
}

async function post(
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  // Built conditionally rather than passing `payload: undefined` — under
  // exactOptionalPropertyTypes that selects a different inject() overload.
  const response = await app.http.inject(
    payload === undefined ? { method: 'POST', url } : { method: 'POST', url, payload },
  );
  return {
    status: response.statusCode,
    body: response.statusCode === 204 ? null : response.json(),
  };
}

async function patch(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await app.http.inject({ method: 'PATCH', url, payload });
  return { status: response.statusCode, body: response.json() };
}

async function put(
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await app.http.inject({ method: 'PUT', url, payload });
  return { status: response.statusCode, body: response.json() };
}

function pipelineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Invoices',
    options: {
      source: { inputPath: inputDir },
      output: { outputPath: outputDir },
      ...overrides,
    },
  };
}

async function authorise(folder: string): Promise<void> {
  const result = await patch('/api/settings', { folderAllowlist: [folder] });
  expect(result.status).toBe(200);
}

describe('health and system', () => {
  it('reports healthy', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('reports hardware, and never leaves a GPU fallback unexplained', async () => {
    const { status, body } = await get('/api/system/hardware');
    const hardware = body as {
      canUseGpu: boolean;
      availableProfiles: string[];
      gpu: { vramBytes: number } | null;
      explanation: string | null;
    };

    expect(status).toBe(200);
    // This asserts the rule rather than the machine: it was written where there was no NVIDIA
    // GPU and CI still has none, but it also runs on developer machines that do have one, and
    // an assertion of `canUseGpu === false` was really an assertion about the hardware.
    expect(hardware.availableProfiles).toContain('fast');

    if (hardware.canUseGpu) {
      expect(hardware.gpu).not.toBeNull();
    } else {
      expect(hardware.availableProfiles).toEqual(['fast']);
      expect(hardware.explanation).toBeTruthy();
    }
  });

  it('starts with the runtime not installed', async () => {
    const { body } = await get('/api/system/runtime');

    expect(body).toMatchObject({ state: 'not-installed' });
  });

  it('accepts a command POST with no body, whatever content type is sent', async () => {
    // Regression: several endpoints are pure commands and clients send them with no body.
    // Fastify answered 415 for a content type it had no parser for, and the error handler
    // then reported it as 500 — the pause button failed with "internal error".
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/json',
    ]) {
      const response = await app.http.inject({
        method: 'POST',
        url: '/api/system/pause',
        headers: { 'content-type': contentType },
      });
      expect(response.statusCode, `content-type: ${contentType}`).toBe(200);
    }
  });

  it('still refuses a non-empty body of an unparseable type', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/api/pipelines',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json',
    });

    // 4xx rather than an exact code: Fastify normalises content-type-parser errors, so what
    // matters is that an unparseable body is rejected as the client's fault, not ours.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it('reports malformed JSON as a client error, not a server error', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/api/pipelines',
      headers: { 'content-type': 'application/json' },
      payload: '{ "name": ',
    });

    expect(response.statusCode).toBe(400);
  });

  it('toggles the global pause and persists it', async () => {
    expect(await post('/api/system/pause')).toMatchObject({ body: { globallyPaused: true } });
    expect((await get('/api/system/status')).body).toMatchObject({ globallyPaused: true });
    expect(await post('/api/system/resume')).toMatchObject({ body: { globallyPaused: false } });
  });
});

describe('settings', () => {
  it('starts with an empty folder allowlist, which blocks everything', async () => {
    const { body } = await get('/api/settings');

    // Fail-closed: a fresh install has authorised nothing.
    expect(body).toMatchObject({ folderAllowlist: [], bindAddress: '127.0.0.1' });
  });

  it('refuses to bind to the network without authentication', async () => {
    const { status, body } = await patch('/api/settings', { bindAddress: '0.0.0.0' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'settings-invalid' });
  });

  it('still refuses when authentication is on but no password exists', async () => {
    // This combination used to be accepted, and it was the whole hole: `authEnabled` was
    // permission to bind to the network rather than a credential protecting it.
    const { status, body } = await patch('/api/settings', {
      bindAddress: '0.0.0.0',
      authEnabled: true,
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'settings-invalid' });
  });

  it('still refuses over plain http once a password exists', async () => {
    await put('/api/auth/password', {
      password: 'a-sufficiently-long-password',
      confirmPassword: 'a-sufficiently-long-password',
    });

    const { status, body } = await patch('/api/settings', {
      bindAddress: '0.0.0.0',
      authEnabled: true,
      scheme: 'http',
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'settings-invalid' });
  });

  it('allows binding to the network with authentication, a password and https', async () => {
    await put('/api/auth/password', {
      password: 'a-sufficiently-long-password',
      confirmPassword: 'a-sufficiently-long-password',
    });

    const { status } = await patch('/api/settings', {
      bindAddress: '0.0.0.0',
      authEnabled: true,
      scheme: 'https',
    });

    expect(status).toBe(200);
  });
});

describe('pipelines', () => {
  it('starts with none', async () => {
    expect(await get('/api/pipelines')).toEqual({ status: 200, body: [] });
  });

  it('refuses a pipeline while no folder is authorised', async () => {
    const { status, body } = await post('/api/pipelines', pipelineBody());

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'pipeline-invalid',
      details: { field: 'source.inputPath' },
    });
    expect((body as { message: string }).message).toContain('No folders are authorised');
  });

  it('creates a pipeline once its folders are authorised', async () => {
    await authorise(root);

    const { status, body } = await post('/api/pipelines', pipelineBody());
    const created = body as { id: string; name: string; status: string; statusReason: string };

    expect(status).toBe(201);
    expect(created.name).toBe('Invoices');
    // Blocked, not idle: the OCR runtime has not been installed in this test environment.
    expect(created.status).toBe('blocked');
    expect(created.statusReason).toContain('runtime is not installed');
  });

  it('rejects a folder outside the allowlist', async () => {
    await authorise(inputDir);

    const { status, body } = await post(
      '/api/pipelines',
      pipelineBody({ output: { outputPath: join(tmpdir(), 'somewhere-else') } }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({ details: { field: 'output.outputPath' } });
  });

  it('rejects an output folder nested inside the input folder', async () => {
    // Otherwise results land back in the watched tree and the pipeline feeds on itself.
    await authorise(root);

    const { status, body } = await post(
      '/api/pipelines',
      pipelineBody({ output: { outputPath: join(inputDir, 'out') } }),
    );

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('cannot be inside the input folder');
  });

  it('rejects a duplicate name', async () => {
    await authorise(root);
    await post('/api/pipelines', pipelineBody());

    const { status, body } = await post('/api/pipelines', pipelineBody());

    expect(status).toBe(400);
    expect(body).toMatchObject({ details: { field: 'name' } });
  });

  it('reports field paths for a malformed body', async () => {
    const { status, body } = await post('/api/pipelines', { name: 'x', options: {} });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'validation-failed' });
  });

  it('pauses and resumes a pipeline', async () => {
    await authorise(root);
    const created = (await post('/api/pipelines', pipelineBody())).body as { id: string };

    const paused = await post(`/api/pipelines/${created.id}/pause`);
    expect(paused.body).toMatchObject({ enabled: false });

    const resumed = await post(`/api/pipelines/${created.id}/resume`);
    expect(resumed.body).toMatchObject({ enabled: true });
  });

  it('deletes a pipeline', async () => {
    await authorise(root);
    const created = (await post('/api/pipelines', pipelineBody())).body as { id: string };

    const response = await app.http.inject({
      method: 'DELETE',
      url: `/api/pipelines/${created.id}`,
    });

    expect(response.statusCode).toBe(204);
    expect((await get('/api/pipelines')).body).toEqual([]);
  });

  it('returns a clean 404 for an unknown pipeline', async () => {
    expect(await get('/api/pipelines/does-not-exist')).toMatchObject({
      status: 404,
      body: { code: 'not-found' },
    });
  });
});

describe('folder validation endpoint', () => {
  it('accepts an authorised folder and returns its canonical path', async () => {
    await authorise(root);

    const { body } = await post('/api/settings/validate-folder', { path: inputDir });

    expect(body).toMatchObject({ valid: true });
  });

  it('rejects an unauthorised folder without echoing the path back', async () => {
    await authorise(inputDir);

    const { body } = await post('/api/settings/validate-folder', {
      path: join(tmpdir(), 'not-authorised'),
    });

    expect(body).toMatchObject({ valid: false, resolvedPath: null });
  });

  it('accepts a folder that does not exist yet when told it need not', async () => {
    // Output folders are created on first write, so they must validate before they exist.
    await authorise(root);

    const { body } = await post('/api/settings/validate-folder', {
      path: join(root, 'not-created-yet'),
      mustExist: false,
    });

    expect(body).toMatchObject({ valid: true });
  });
});

describe('folder browsing', () => {
  it('lists the authorised folders at the root of the confined browser', async () => {
    await authorise(root);

    const { status, body } = await get('/api/filesystem/browse');
    const result = body as { isRoot: boolean; entries: { path: string }[] };

    expect(status).toBe(200);
    expect(result.isRoot).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toEqual([root]);
  });

  it('lists subfolders of an authorised folder', async () => {
    await authorise(root);

    const { body } = await get(`/api/filesystem/browse?path=${encodeURIComponent(root)}`);

    expect((body as { entries: { name: string }[] }).entries.map((e) => e.name)).toContain('in');
  });

  it('refuses to browse outside the allowlist', async () => {
    await authorise(inputDir);

    const { status } = await get(
      `/api/filesystem/browse?path=${encodeURIComponent(tmpdir())}&scope=allowlist`,
    );

    expect(status).toBe(403);
  });

  it('allows unconfined browsing while bound to loopback', async () => {
    // The bootstrapping case: you cannot pick a folder for the allowlist from inside the
    // allowlist. Loopback means the user is already sitting at this machine.
    const { status, body } = await get('/api/filesystem/browse?scope=system');

    expect(status).toBe(200);
    expect((body as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
  });

  it('creates a folder inside the allowlist', async () => {
    await authorise(root);

    const { status, body } = await post('/api/filesystem/create-folder', {
      path: join(root, 'brand-new'),
    });

    expect(status).toBe(201);
    expect((body as { path: string }).path.toLowerCase()).toContain('brand-new');
  });

  it('refuses to create a folder outside the allowlist', async () => {
    await authorise(inputDir);

    const { status } = await post('/api/filesystem/create-folder', {
      path: join(tmpdir(), 'impressive-ocr-should-not-exist'),
    });

    expect(status).toBe(403);
  });
});

describe('jobs', () => {
  it('starts with an empty list', async () => {
    expect(await get('/api/jobs')).toMatchObject({
      status: 200,
      body: { items: [], total: 0 },
    });
  });

  it('returns 404 for an unknown job', async () => {
    expect((await get('/api/jobs/nope')).status).toBe(404);
  });
});

describe('unknown endpoints', () => {
  it('returns a structured 404 for an unknown API path', async () => {
    expect(await get('/api/nope')).toMatchObject({
      status: 404,
      body: { code: 'not-found' },
    });
  });
});

describe('quick mode results', () => {
  /**
   * The per-file download addresses a result by its position in the server's own list, so
   * that no filename from the client is ever joined to a path. These cover the boundary of
   * that scheme: anything not a valid position must be a 404, never a 500 and never a file.
   */
  it('lists nothing for a pipeline that produced nothing', async () => {
    expect(await get('/api/quick/runs/unknown-pipeline/files')).toMatchObject({
      status: 200,
      body: [],
    });
  });

  it('refuses an out-of-range file index', async () => {
    expect((await get('/api/quick/runs/unknown-pipeline/files/0')).status).toBe(404);
  });

  it.each(['-1', '1.5', 'abc', '..%2F..%2Fetc%2Fpasswd'])(
    'refuses %s as a file index',
    async (index) => {
      expect((await get(`/api/quick/runs/unknown-pipeline/files/${index}`)).status).toBe(404);
    },
  );
});
