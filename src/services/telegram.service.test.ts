import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  default: {
    telegram: {
      botToken: 'test-token',
      botUsername: 'test_bot',
      webhookSecret: '',
    },
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('axios', () => ({
  default: { create: vi.fn(() => ({ post: postMock, get: vi.fn() })) },
}));

function telegram429(retryAfterSeconds: number) {
  const err: any = new Error('Too Many Requests');
  err.response = {
    status: 429,
    data: { ok: false, error_code: 429, parameters: { retry_after: retryAfterSeconds } },
  };
  return err;
}

function telegram500() {
  const err: any = new Error('Internal Server Error');
  err.response = { status: 500, data: {} };
  return err;
}

function telegram403() {
  const err: any = new Error('Forbidden');
  err.response = { status: 403, data: { description: 'bot was blocked by the user' } };
  return err;
}

describe('TelegramService.sendMessage retry behavior', () => {
  beforeEach(() => {
    postMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors retry_after from a 429 response before retrying', async () => {
    const { TelegramService } = await import('./telegram.service');

    postMock
      .mockRejectedValueOnce(telegram429(3))
      .mockResolvedValueOnce({ data: { ok: true } });

    const send = TelegramService.sendMessage('123', 'hi');
    // Swallow rejection during pending state; we assert success at the end.
    send.catch(() => {});

    // Let the first post() settle and the retry delay start.
    await vi.advanceTimersByTimeAsync(0);
    expect(postMock).toHaveBeenCalledTimes(1);

    // Waiting less than retry_after should NOT fire the retry yet.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(postMock).toHaveBeenCalledTimes(1);

    // Crossing retry_after triggers exactly one retry.
    await vi.advanceTimersByTimeAsync(1);
    await send;
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('uses a short default wait when a 5xx has no retry_after', async () => {
    const { TelegramService } = await import('./telegram.service');

    postMock
      .mockRejectedValueOnce(telegram500())
      .mockResolvedValueOnce({ data: { ok: true } });

    const send = TelegramService.sendMessage('123', 'hi');
    send.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(postMock).toHaveBeenCalledTimes(1);

    // The current implementation uses 500ms as the default non-429 backoff.
    await vi.advanceTimersByTimeAsync(499);
    expect(postMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await send;
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry terminal 4xx errors (e.g., bot blocked)', async () => {
    const { TelegramService } = await import('./telegram.service');

    postMock.mockRejectedValueOnce(telegram403());

    await expect(TelegramService.sendMessage('123', 'hi')).rejects.toBeTruthy();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the retry failure if the second attempt also fails', async () => {
    const { TelegramService } = await import('./telegram.service');

    postMock
      .mockRejectedValueOnce(telegram429(1))
      .mockRejectedValueOnce(telegram500());

    const send = TelegramService.sendMessage('123', 'hi');
    const asserted = expect(send).rejects.toBeTruthy();

    await vi.advanceTimersByTimeAsync(1_000);
    await asserted;
    expect(postMock).toHaveBeenCalledTimes(2);
  });
});
