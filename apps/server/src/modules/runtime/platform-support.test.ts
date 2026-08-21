// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describePlatform } from './platform-support';

/**
 * The distinction is emulation, not ARM.
 *
 * PaddlePaddle 3.3.1 ships macosx_11_0_arm64, manylinux1_x86_64 and win_amd64 — so Apple
 * Silicon is native and fully supported, while Windows on ARM has no wheel at all and must
 * emulate. Getting this backwards would either exclude a first-class platform or let users
 * discover an unsupported one through silent crashes.
 */
describe('describePlatform', () => {
  it('treats Apple Silicon as native, because a native wheel exists', () => {
    const report = describePlatform({ platform: 'darwin', arch: 'arm64' });

    expect(report.support).toBe('native');
    expect(report.reason).toBe('');
  });

  it('treats an Intel Mac as native', () => {
    expect(describePlatform({ platform: 'darwin', arch: 'x64' }).support).toBe('native');
  });

  it('treats Windows on x86-64 as native', () => {
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      processorArchitecture: 'AMD64',
    });

    expect(report.support).toBe('native');
  });

  it('spots a real Snapdragon X, where every architecture variable lies', () => {
    // Measured on the machine itself: process.arch is x64, PROCESSOR_ARCHITECTURE is AMD64,
    // and PROCESSOR_ARCHITEW6432 is not set at all. Only the CPU model gives it away, which
    // is why relying on the variables alone reported this box as native.
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      processorArchitecture: 'AMD64',
      processorArchitew6432: undefined,
      cpuModel: 'Snapdragon(R) X 12-core X1E80100 @ 3.40 GHz',
    });

    expect(report.support).toBe('emulated');
    expect(report.reason).toContain('emulation');
  });

  it('still honours the architecture variables where Windows does set them', () => {
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      processorArchitew6432: 'ARM64',
    });

    expect(report.support).toBe('emulated');
  });

  it('says what to do instead, rather than only what is wrong', () => {
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      processorArchitew6432: 'ARM64',
    });

    expect(report.reason).toContain('Apple Silicon');
  });

  it('reports Linux on ARM as unsupported, since no wheel exists there either', () => {
    const report = describePlatform({ platform: 'linux', arch: 'arm64' });

    expect(report.support).toBe('unsupported');
  });

  it('treats Linux on x86-64 as native', () => {
    expect(describePlatform({ platform: 'linux', arch: 'x64' }).support).toBe('native');
  });

  it('does not mistake a plain x86-64 box for an emulated one', () => {
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      processorArchitecture: 'AMD64',
      processorArchitew6432: undefined,
      cpuModel: '12th Gen Intel(R) Core(TM) i7-1265U',
    });

    expect(report.support).toBe('native');
  });

  it('does not flag an AMD chip because its name contains no ARM marker', () => {
    const report = describePlatform({
      platform: 'win32',
      arch: 'x64',
      cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor',
    });

    expect(report.support).toBe('native');
  });
});
