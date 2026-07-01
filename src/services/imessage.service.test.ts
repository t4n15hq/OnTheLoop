import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared, mutable config object so individual tests can flip the feature flag.
// The service imports the default export by reference, so mutating fields here
// is seen by the (re-imported) service.
const h = vi.hoisted(() => {
  const sendMock = vi.fn();
  const createMock = vi.fn();
  const SpectrumMock = vi.fn();
  const providerConfig = vi.fn(() => ({}));
  const cfg = {
    imessage: {
      enabled: true,
      mode: 'cloud' as 'cloud' | 'local' | 'dedicated',
      projectId: 'proj_123',
      projectSecret: 'secret_123',
    },
  };
  return { sendMock, createMock, SpectrumMock, providerConfig, cfg };
});

vi.mock('../config', () => ({ default: h.cfg }));
vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock the Spectrum SDK + iMessage provider so the real (native-dep-heavy)
// package never loads during tests.
vi.mock('spectrum-ts', () => ({ Spectrum: h.SpectrumMock }));
vi.mock('spectrum-ts/providers/imessage', () => ({
  imessage: Object.assign(
    // provider(spectrum) -> platform instance with a space namespace
    (_spectrum: unknown) => ({ space: { create: h.createMock } }),
    { config: h.providerConfig }
  ),
}));

async function freshService() {
  // Reset the module registry so the service singleton's lazy init cache is
  // clean for each test.
  vi.resetModules();
  return (await import('./imessage.service')).IMessageService;
}

describe('IMessageService.sendIMessage', () => {
  beforeEach(() => {
    h.sendMock.mockReset();
    h.createMock.mockReset();
    h.SpectrumMock.mockReset();
    h.providerConfig.mockClear();
    // Default: enabled cloud mode with creds, provider wired to succeed.
    h.cfg.imessage.enabled = true;
    h.cfg.imessage.mode = 'cloud';
    h.cfg.imessage.projectId = 'proj_123';
    h.cfg.imessage.projectSecret = 'secret_123';
    h.SpectrumMock.mockResolvedValue({ stop: vi.fn() });
    h.createMock.mockResolvedValue({ send: h.sendMock });
    h.sendMock.mockResolvedValue(undefined);
  });

  it('swallows a provider error and returns { ok: false } without throwing', async () => {
    h.sendMock.mockRejectedValueOnce(new Error('provider boom'));

    const IMessageService = await freshService();
    const result = await IMessageService.sendIMessage('+15551234567', 'hello');

    expect(result.ok).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.detail).toContain('boom');
    // The provider WAS reached (not short-circuited).
    expect(h.SpectrumMock).toHaveBeenCalledTimes(1);
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('swallows an init error and stays retryable (no throw)', async () => {
    h.SpectrumMock.mockRejectedValueOnce(new Error('init failed'));

    const IMessageService = await freshService();
    const first = await IMessageService.sendIMessage('+15551234567', 'hi');
    expect(first.ok).toBe(false);
    expect(first.detail).toContain('init failed');

    // Cache was cleared on failed init, so a later send can retry and succeed.
    const second = await IMessageService.sendIMessage('+15551234567', 'hi again');
    expect(second.ok).toBe(true);
    expect(h.SpectrumMock).toHaveBeenCalledTimes(2);
  });

  it('short-circuits when the feature flag is disabled (provider never touched)', async () => {
    h.cfg.imessage.enabled = false;

    const IMessageService = await freshService();
    const result = await IMessageService.sendIMessage('+15551234567', 'hello');

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(h.SpectrumMock).not.toHaveBeenCalled();
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('short-circuits in cloud mode when credentials are missing', async () => {
    h.cfg.imessage.projectSecret = '';

    const IMessageService = await freshService();
    expect(IMessageService.isReady()).toBe(false);

    const result = await IMessageService.sendIMessage('+15551234567', 'hello');
    expect(result.skipped).toBe(true);
    expect(h.SpectrumMock).not.toHaveBeenCalled();
  });

  it('sends successfully when enabled and configured', async () => {
    const IMessageService = await freshService();
    const result = await IMessageService.sendIMessage('user@icloud.com', 'ping');

    expect(result.ok).toBe(true);
    expect(h.createMock).toHaveBeenCalledWith('user@icloud.com');
    expect(h.sendMock).toHaveBeenCalledWith('ping');
  });
});
