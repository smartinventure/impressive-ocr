// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref, type Ref } from 'vue';
import { PROCESSABLE_EXTENSIONS } from '@impressive-ocr/shared';
import { quickApi, type QuickFolderPreview } from '../../../api/endpoints';

/**
 * What the chosen folders hold, and therefore what a run over them would read.
 *
 * A folder chooser returns a name and nothing else, so "run this folder" is a decision made
 * blind: whether it is the right folder, whether it has anything readable in it, and how much
 * work is about to start are all invisible until after the click. The server can answer all
 * three by listing the folder once, when it is added.
 *
 * Counted per folder and cached by path. Adding a tenth folder then costs one listing rather
 * than ten, which matters when they are on a network share.
 */

export interface FolderPreviews {
  /** Types present in at least one chosen folder, ordered as `PROCESSABLE_EXTENSIONS` is. */
  availableExtensions: Ref<readonly string[]>;
  /** Files the chosen folders and types come to, which is what a run would process. */
  selectedFileCount: Ref<number>;
  /** Files in those folders the engine cannot read, so a smaller count is explainable. */
  unreadableCount: Ref<number>;
  /** True while any folder is still being listed; the count below is not final yet. */
  loading: Ref<boolean>;
  /** Why a folder could not be listed, by path. Usually: not authorised, or since deleted. */
  errors: Ref<Record<string, string>>;
  /** How many files one folder contributes, for the row that names it. */
  countFor: (path: string) => number;
  load: (path: string) => Promise<void>;
  forget: (path: string) => void;
}

export function useFolderPreviews(selectedExtensions: Ref<readonly string[]>): FolderPreviews {
  const previews = ref<Record<string, QuickFolderPreview>>({});
  const errors = ref<Record<string, string>>({});
  const inFlight = ref(0);

  const loading = computed(() => inFlight.value > 0);

  const availableExtensions = computed(() => {
    const present = new Set<string>();
    for (const preview of Object.values(previews.value)) {
      for (const entry of preview.counts) present.add(entry.extension);
    }
    // Filtered from the canonical order rather than collected in encounter order, so the
    // chips keep their positions when a second folder introduces a type the first lacked.
    return PROCESSABLE_EXTENSIONS.filter((extension) => present.has(extension));
  });

  function countIn(preview: QuickFolderPreview): number {
    return preview.counts
      .filter((entry) => selectedExtensions.value.includes(entry.extension))
      .reduce((total, entry) => total + entry.files, 0);
  }

  const selectedFileCount = computed(() =>
    Object.values(previews.value).reduce((total, preview) => total + countIn(preview), 0),
  );

  const unreadableCount = computed(() =>
    Object.values(previews.value).reduce((total, preview) => total + preview.other, 0),
  );

  function countFor(path: string): number {
    const preview = previews.value[path];
    return preview === undefined ? 0 : countIn(preview);
  }

  async function load(path: string): Promise<void> {
    if (previews.value[path] !== undefined) return;

    inFlight.value += 1;
    try {
      const preview = await quickApi.folderPreview(path);
      previews.value = { ...previews.value, [path]: preview };
      const { [path]: _removed, ...rest } = errors.value;
      errors.value = rest;
    } catch (error) {
      // Kept against the folder rather than raised, because one unreadable folder must not
      // discard the others the user already chose.
      errors.value = {
        ...errors.value,
        [path]: error instanceof Error ? error.message : 'That folder could not be read.',
      };
    } finally {
      inFlight.value -= 1;
    }
  }

  function forget(path: string): void {
    const { [path]: _preview, ...remainingPreviews } = previews.value;
    previews.value = remainingPreviews;
    const { [path]: _error, ...remainingErrors } = errors.value;
    errors.value = remainingErrors;
  }

  return {
    availableExtensions,
    selectedFileCount,
    unreadableCount,
    loading,
    errors,
    countFor,
    load,
    forget,
  };
}
