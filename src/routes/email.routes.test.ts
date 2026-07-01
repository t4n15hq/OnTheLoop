import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic secret so generate/verify agree across the test.
vi.mock('../config', () => ({
  default: {
    jwt: { secret: 'test-secret' },
    publicUrl: 'https://example.test',
  },
}));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const userUpdate = vi.fn().mockResolvedValue({});
vi.mock('../utils/db', () => ({
  default: { user: { update: (...args: unknown[]) => userUpdate(...args) } },
}));

describe('one-click unsubscribe token', () => {
  beforeEach(() => {
    userUpdate.mockClear();
  });

  it('flips emailNotifications off for a validly signed token', async () => {
    const { applyUnsubscribe } = await import('./email.routes');
    const { generateUnsubscribeToken } = await import('../utils/unsubscribe');

    const userId = 'user-123';
    const token = generateUnsubscribeToken(userId);

    const ok = await applyUnsubscribe(userId, token);

    expect(ok).toBe(true);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: userId },
      data: { emailNotifications: false },
    });
  });

  it('rejects a tampered token and does not touch the database', async () => {
    const { applyUnsubscribe } = await import('./email.routes');
    const { generateUnsubscribeToken } = await import('../utils/unsubscribe');

    const userId = 'user-123';
    const token = generateUnsubscribeToken(userId);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');

    const ok = await applyUnsubscribe(userId, tampered);

    expect(ok).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();

    // A token signed for a different user must not unsubscribe this one.
    const otherOk = await applyUnsubscribe(userId, generateUnsubscribeToken('someone-else'));
    expect(otherOk).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
