// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { PROCESSABLE_EXTENSIONS } from '@impressive-ocr/shared';
import FileSourcePicker from './file-source-picker.vue';
import en from '../../../locales/en.json';

/**
 * Which controls each source offers, and the rule that files and folders never mix.
 *
 * This exists because of a regression that shipped: the upload branch was a bare `v-else`, so
 * inserting the folder button above it re-pointed that `v-else` at the *new* condition. In a
 * browser, where a folder cannot be picked, the upload branch then rendered beside the server
 * one and the page showed two buttons both saying "Add files". Nothing tested the picker, so
 * nothing noticed.
 */

const folderPreview = vi.hoisted(() => vi.fn());
const selectFolder = vi.hoisted(() => vi.fn());
const selectFiles = vi.hoisted(() => vi.fn());
const isDesktop = vi.hoisted(() => ({ value: false }));

vi.mock('../../../api/endpoints', () => ({
  filesystemApi: { browse: vi.fn().mockResolvedValue({ entries: [], currentPath: null }) },
  quickApi: { folderPreview: (...args: unknown[]) => folderPreview(...args) },
}));

vi.mock('../../../composables/use-desktop-bridge', () => ({
  useDesktopBridge: () => ({ isDesktop, selectFolder, selectFiles }),
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

interface Overrides {
  serverFiles?: string[];
  serverFolders?: string[];
  folderExtensions?: string[];
}

function picker(source: 'server' | 'upload', overrides: Overrides = {}) {
  return mount(FileSourcePicker, {
    props: {
      source,
      serverFiles: [],
      uploadFiles: [],
      serverFolders: [],
      folderExtensions: [...PROCESSABLE_EXTENSIONS],
      folderFileCount: 0,
      ...overrides,
    },
    global: { plugins: [vuetify, i18n] },
  });
}

type Picker = ReturnType<typeof picker>;

/** Buttons whose own label is "Add files", ignoring the dialog title that shares the string. */
function addFilesButtons(wrapper: Picker) {
  return wrapper
    .findAllComponents({ name: 'VBtn' })
    .filter((button) => button.text().trim().toLowerCase() === 'add files');
}

function buttonLabelled(wrapper: Picker, label: string) {
  return wrapper
    .findAllComponents({ name: 'VBtn' })
    .find((button) => button.text().trim().toLowerCase() === label.toLowerCase());
}

async function settle(wrapper: Picker): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  isDesktop.value = false;
  selectFiles.mockResolvedValue([]);
  selectFolder.mockResolvedValue(null);
  folderPreview.mockResolvedValue({ path: '', counts: [], other: 0 });
});

describe('FileSourcePicker', () => {
  it('offers one way to add files on the server, not two', () => {
    expect(addFilesButtons(picker('server'))).toHaveLength(1);
  });

  it('offers one way to add files from this computer, not two', () => {
    expect(addFilesButtons(picker('upload'))).toHaveLength(1);
  });

  it('does not show the upload input while the server is selected', () => {
    // The tell for the regression: the file input belongs to the other branch entirely.
    expect(picker('server').find('input[type="file"]').exists()).toBe(false);
  });

  it('shows the upload input when this computer is selected', () => {
    expect(picker('upload').find('input[type="file"]').exists()).toBe(true);
  });

  it('does not offer a folder in a browser, where one cannot be chosen', () => {
    // `selectFolder` needs the desktop bridge; without it the button would open nothing.
    // Asserted on the button rather than the page text, which explains both ways in by name.
    expect(buttonLabelled(picker('server'), 'Add a folder')).toBeUndefined();
  });

  it('explains what each way in does before either is used', () => {
    // The difference that matters is what happens to the originals, and a folder run leaving
    // them alone is not something to have to discover afterwards.
    const text = picker('server').text();

    expect(text).toContain('nothing is moved');
    expect(text).toContain('Subfolders are not included');
  });
});

/**
 * Files and folders as one choice.
 *
 * They were previously exclusive by *clearing*: choosing a folder silently discarded the files
 * already picked. The two are not the same kind of choice -- a list the user curates against a
 * standing instruction the server resolves -- and quietly throwing one away reads as a bug.
 */
describe('FileSourcePicker exclusivity', () => {
  beforeEach(() => {
    isDesktop.value = true;
  });

  it('blocks adding files once a folder is chosen', () => {
    const wrapper = picker('server', { serverFolders: ['C:/scans'] });

    expect(buttonLabelled(wrapper, 'Add files')?.props('disabled')).toBe(true);
  });

  it('blocks adding a folder once files are chosen', () => {
    const wrapper = picker('server', { serverFiles: ['C:/scans/one.pdf'] });

    expect(buttonLabelled(wrapper, 'Add a folder')?.props('disabled')).toBe(true);
  });

  it('says why, rather than only greying out', () => {
    // A disabled button emits no pointer events, so a tooltip bound to it would never open.
    // The hint has to sit on a wrapping span.
    const wrapper = picker('server', { serverFolders: ['C:/scans'] });

    const hints = wrapper.findAll('span[title]').map((node) => node.attributes('title'));
    expect(hints.some((hint) => hint?.includes('Remove the folders first'))).toBe(true);
  });

  it('leaves both available when nothing is chosen yet', () => {
    const wrapper = picker('server');

    expect(buttonLabelled(wrapper, 'Add files')?.props('disabled')).toBe(false);
    expect(buttonLabelled(wrapper, 'Add a folder')?.props('disabled')).toBe(false);
  });
});

/**
 * How much work a folder run is about to start.
 *
 * A folder chooser returns a name and nothing else, so this was invisible until after the
 * click. The server lists each folder once as it is added; the count, the chips and the
 * warnings below are all derived from that one listing.
 */
describe('FileSourcePicker folder counts', () => {
  const SCANS = [
    { extension: 'pdf', files: 3 },
    { extension: 'png', files: 2 },
  ];

  beforeEach(() => {
    isDesktop.value = true;
  });

  /** Add a folder the way the user does, then apply what the parent's v-model would. */
  async function addFolder(
    wrapper: Picker,
    path: string,
    counts: { extension: string; files: number }[],
    other = 0,
  ): Promise<void> {
    selectFolder.mockResolvedValue(path);
    folderPreview.mockResolvedValue({ path, counts, other });

    await buttonLabelled(wrapper, 'Add a folder')?.trigger('click');
    await settle(wrapper);
    await wrapper.setProps({ serverFolders: [...wrapper.props('serverFolders'), path] });
    await settle(wrapper);
  }

  it('counts what would be read, not what is in the folder', async () => {
    const wrapper = picker('server', { folderExtensions: ['pdf', 'png'] });
    await addFolder(wrapper, 'C:/scans', SCANS, 7);

    expect(wrapper.text()).toContain('5 file(s) will be read.');
    expect(wrapper.text()).toContain('7 other file(s)');
  });

  it('recounts when a type is deselected', async () => {
    const wrapper = picker('server', { folderExtensions: ['pdf', 'png'] });
    await addFolder(wrapper, 'C:/scans', SCANS);

    await wrapper.setProps({ folderExtensions: ['pdf'] });
    await settle(wrapper);

    expect(wrapper.text()).toContain('3 file(s) will be read.');
  });

  it('offers chips only for types the folders actually hold', async () => {
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', SCANS);

    const chips = wrapper.findAllComponents({ name: 'VChip' }).map((chip) => chip.text().trim());
    expect(chips).toEqual(['PDF', 'PNG']);
  });

  it('adds a second folder rather than replacing the first', async () => {
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', SCANS);
    await addFolder(wrapper, 'D:/more', [{ extension: 'tiff', files: 4 }]);

    expect(wrapper.text()).toContain('C:/scans');
    expect(wrapper.text()).toContain('D:/more');
    // Nine, not four: a second folder is an addition, and its new type joins the chips.
    expect(wrapper.text()).toContain('9 file(s) will be read.');
    const chips = wrapper.findAllComponents({ name: 'VChip' }).map((chip) => chip.text().trim());
    expect(chips).toContain('TIFF');
  });

  it('nudges when the ticked types match nothing, however many are ticked', async () => {
    // The selection holds every readable type by default, so a message keyed on it being
    // empty would never appear: untick PDF on a folder of PDFs and seven types are still
    // selected while nothing at all would be read.
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', [{ extension: 'pdf', files: 3 }]);

    await wrapper.setProps({ folderExtensions: ['png', 'jpg', 'tiff'] });
    await settle(wrapper);

    expect(wrapper.text()).toContain('Choose at least one file type');
  });

  it('says so when a folder holds nothing the engine can read', async () => {
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', [], 12);

    expect(wrapper.text()).toContain('Nothing here can be read');
  });

  it('reports the count upwards, because the Start button depends on it', async () => {
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', SCANS);

    const emitted = wrapper.emitted('update:folderFileCount');
    expect(emitted?.[emitted.length - 1]).toEqual([5]);
  });

  it('keeps the other folders when one cannot be read', async () => {
    const wrapper = picker('server');
    await addFolder(wrapper, 'C:/scans', SCANS);

    selectFolder.mockResolvedValue('E:/gone');
    folderPreview.mockRejectedValue(new Error('That folder could not be read.'));
    await buttonLabelled(wrapper, 'Add a folder')?.trigger('click');
    await settle(wrapper);
    await wrapper.setProps({ serverFolders: ['C:/scans', 'E:/gone'] });
    await settle(wrapper);

    expect(wrapper.text()).toContain('That folder could not be read.');
    expect(wrapper.text()).toContain('5 file(s) will be read.');
  });
});
