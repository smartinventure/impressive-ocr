// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PipelineRow } from '@impressive-ocr/db';
import {
  pipelineOptionsSchema,
  type CreatePipelineRequest,
  type HardwareCapabilities,
  type Pipeline,
  type PipelineOptions,
  type PipelineWithStatus,
  type UpdatePipelineRequest,
} from '@impressive-ocr/shared';
import { PathNotAllowedError, resolveSafePath } from '../../infra/fs/safe-path';
import { createId } from '../../infra/ids';
import type { Logger } from '../../infra/logger';
import { type EventBus, stamp } from '../events/event-bus';
import type { JobRepository } from '../queue/job-repository';
import { isPipelineEligible } from '../queue/scheduling-policy';
import type { SettingsService } from '../settings/settings-service';
import type { PipelineRepository } from './pipeline-repository';

/**
 * Pipeline lifecycle: validation, path authorisation, persistence, events.
 *
 * Every filesystem path a pipeline names is canonicalized and checked against the user's
 * folder allowlist *here*, before it is ever stored. Validating at write time rather than at
 * use time means a hostile or mistaken path never reaches the watcher or the sidecar, and the
 * stored path is already the canonical one.
 */

export class PipelineValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'PipelineValidationError';
  }
}

export interface PipelineServiceOptions {
  repository: PipelineRepository;
  jobs: JobRepository;
  settings: SettingsService;
  events: EventBus;
  logger: Logger;
  hardware: () => HardwareCapabilities;
  isRuntimeReady: () => boolean;
  isGloballyPaused: () => boolean;
  /** Called after any change so the watcher set can be brought back in sync. */
  onPipelinesChanged: () => void;
}

export class PipelineService {
  constructor(private readonly options: PipelineServiceOptions) {}

  list(): PipelineWithStatus[] {
    return this.options.repository.list().map((pipeline) => this.decorate(pipeline));
  }

  get(id: string): PipelineWithStatus | null {
    const pipeline = this.options.repository.find(id);
    return pipeline === null ? null : this.decorate(pipeline);
  }

  async create(request: CreatePipelineRequest): Promise<PipelineWithStatus> {
    if (this.options.repository.nameExists(request.name)) {
      throw new PipelineValidationError('A pipeline with this name already exists', 'name');
    }
    const options = await this.validateOptions(request.options);
    const now = new Date().toISOString();

    const row: PipelineRow = {
      id: createId(),
      name: request.name,
      description: request.description ?? '',
      enabled: request.enabled,
      options,
      priority: options.schedule.priority,
      createdAt: now,
      updatedAt: now,
    };

    const created = this.options.repository.insert(row);
    this.options.logger.info({ pipelineId: created.id, name: created.name }, 'Pipeline created');
    return this.publish(created);
  }

  async update(id: string, request: UpdatePipelineRequest): Promise<PipelineWithStatus | null> {
    const existing = this.options.repository.find(id);
    if (existing === null) {
      return null;
    }
    if (request.name !== undefined && this.options.repository.nameExists(request.name, id)) {
      throw new PipelineValidationError('A pipeline with this name already exists', 'name');
    }

    const options =
      request.options === undefined
        ? existing.options
        : await this.validateOptions(request.options);

    const changes: Partial<PipelineRow> = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      options,
      priority: options.schedule.priority,
      updatedAt: new Date().toISOString(),
    };

    const updated = this.options.repository.update(id, changes);
    return updated === null ? null : this.publish(updated);
  }

  delete(id: string): boolean {
    const deleted = this.options.repository.delete(id);
    if (deleted) {
      this.options.events.publish(stamp({ type: 'pipeline.deleted', pipelineId: id }));
      this.options.onPipelinesChanged();
    }
    return deleted;
  }

  /** Pause or resume one pipeline. */
  async setEnabled(id: string, enabled: boolean): Promise<PipelineWithStatus | null> {
    const updated = this.options.repository.update(id, {
      enabled,
      updatedAt: new Date().toISOString(),
    });
    return updated === null ? null : this.publish(updated);
  }

  /**
   * Validate and canonicalize every path in an option set.
   *
   * The output and archive folders are allowed not to exist yet — we create them on first
   * write — but they must still resolve inside the allowlist, so a not-yet-created folder
   * cannot be used to sneak past the check.
   */
  private async validateOptions(raw: PipelineOptions): Promise<PipelineOptions> {
    const options = pipelineOptionsSchema.parse(raw);
    const allowlist = this.options.settings.allowlist();

    if (allowlist.length === 0) {
      throw new PipelineValidationError(
        'No folders are authorised yet. Add at least one folder to the allowlist in Settings.',
        'source.inputPath',
      );
    }

    const inputPath = await this.checkPath(
      options.source.inputPath,
      allowlist,
      true,
      'source.inputPath',
    );
    const outputPath = await this.checkPath(
      options.output.outputPath,
      allowlist,
      false,
      'output.outputPath',
    );

    const archivePath =
      options.postProcessing.archivePath === undefined
        ? undefined
        : await this.checkPath(
            options.postProcessing.archivePath,
            allowlist,
            false,
            'postProcessing.archivePath',
          );

    const quarantinePath =
      options.reliability.quarantinePath === undefined
        ? undefined
        : await this.checkPath(
            options.reliability.quarantinePath,
            allowlist,
            false,
            'reliability.quarantinePath',
          );

    assertNotNested(inputPath, outputPath);

    return {
      ...options,
      source: { ...options.source, inputPath },
      output: { ...options.output, outputPath },
      postProcessing: {
        ...options.postProcessing,
        ...(archivePath === undefined ? {} : { archivePath }),
      },
      reliability: {
        ...options.reliability,
        ...(quarantinePath === undefined ? {} : { quarantinePath }),
      },
    };
  }

  private async checkPath(
    candidate: string,
    allowlist: readonly string[],
    mustExist: boolean,
    field: string,
  ): Promise<string> {
    try {
      return await resolveSafePath(candidate, { allowlist, mustExist });
    } catch (error) {
      if (error instanceof PathNotAllowedError) {
        throw new PipelineValidationError(describeRejection(error), field);
      }
      throw error;
    }
  }

  private publish(pipeline: Pipeline): PipelineWithStatus {
    const decorated = this.decorate(pipeline);
    this.options.events.publish(stamp({ type: 'pipeline.upserted', pipeline: decorated }));
    this.options.onPipelinesChanged();
    return decorated;
  }

  private decorate(pipeline: Pipeline): PipelineWithStatus {
    const stats = this.options.jobs.statsFor(pipeline.id);
    const verdict = isPipelineEligible(pipeline, {
      globallyPaused: this.options.isGloballyPaused(),
      now: new Date(),
      runtimeReady: this.options.isRuntimeReady(),
    });

    return {
      ...pipeline,
      status: stats.running > 0 ? 'running' : verdict.eligible ? 'idle' : 'blocked',
      statusReason: verdict.reason,
      stats,
    };
  }
}

/**
 * Refuse an output folder inside the input folder.
 *
 * Otherwise every result written lands back in the watched tree, gets picked up as new input,
 * and the pipeline feeds on itself until the disk fills. It is an easy mistake to make and an
 * expensive one to discover.
 */
export function assertNotNested(inputPath: string, outputPath: string): void {
  const input = normalize(inputPath);
  const output = normalize(outputPath);

  if (output === input || output.startsWith(`${input}/`)) {
    throw new PipelineValidationError(
      'The output folder cannot be inside the input folder — results would be picked up as new input.',
      'output.outputPath',
    );
  }
}

function normalize(value: string): string {
  const slashed = value.split('\\').join('/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function describeRejection(error: PathNotAllowedError): string {
  switch (error.reason) {
    case 'not-absolute':
      return 'Enter an absolute path.';
    case 'contains-null-byte':
      return 'The path contains invalid characters.';
    case 'allowlist-empty':
      return 'No folders are authorised yet. Add one in Settings first.';
    case 'outside-allowlist':
      return 'This folder is outside the authorised folders. Add it to the allowlist in Settings.';
    case 'does-not-exist':
      return 'This folder does not exist.';
  }
}
