import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// --- Mocks -----------------------------------------------------------------
// vi.mock factories are hoisted above module-scope consts, so the shared mocks
// live inside vi.hoisted() to be available when the factories run.

const { prismaMock, sendPasswordResetEmail } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock('../utils/db', () => ({ default: prismaMock }));

vi.mock('../utils/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config', () => ({
  default: {
    jwt: { secret: 'test-secret', expiresIn: '7d' },
    publicUrl: 'https://ontheloop.app',
  },
}));

vi.mock('./email.service', () => ({
  default: { sendPasswordResetEmail },
}));

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

// Imported after mocks are registered.
import { AuthService } from './auth.service';

beforeEach(() => {
  vi.clearAllMocks();
  sendPasswordResetEmail.mockResolvedValue(true);
});

// --- Password reset --------------------------------------------------------

describe('AuthService password reset', () => {
  it('forgot-password stores a HASHED token + 30min expiry and emails the raw token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    prismaMock.user.update.mockResolvedValue({});

    const before = Date.now();
    await AuthService.requestPasswordReset('A@B.com');

    expect(prismaMock.user.update).toHaveBeenCalledOnce();
    const data = prismaMock.user.update.mock.calls[0][0].data;

    // Stored token is a sha256 hex digest, never the raw token.
    expect(data.passwordResetToken).toMatch(/^[a-f0-9]{64}$/);
    // ~30 minute expiry.
    const ttl = new Date(data.passwordResetExpires).getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);

    // Email carries the RAW token; the stored hash matches sha256(raw).
    expect(sendPasswordResetEmail).toHaveBeenCalledOnce();
    const link: string = sendPasswordResetEmail.mock.calls[0][1];
    const raw = new URL(link).searchParams.get('token');
    expect(raw).toBeTruthy();
    expect(data.passwordResetToken).toBe(sha256(raw as string));
    expect(link.startsWith('https://ontheloop.app/reset-password')).toBe(true);
  });

  it('forgot-password on an unknown email is a silent no-op (no enumeration)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(AuthService.requestPasswordReset('nobody@x.com')).resolves.toBeUndefined();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('reset-password consumes a valid token: sets a new hash, stamps passwordChangedAt, clears the token', async () => {
    const raw = 'a'.repeat(64);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordResetToken: sha256(raw),
      passwordResetExpires: new Date(Date.now() + 10_000),
    });
    prismaMock.user.update.mockResolvedValue({});

    await AuthService.resetPassword(raw, 'brand-new-password');

    // Looked up by the HASHED token, not the raw one.
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { passwordResetToken: sha256(raw) },
    });

    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(typeof data.password).toBe('string');
    expect(data.password).not.toBe('brand-new-password'); // hashed
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    // Single-use: token is cleared so it can't be replayed.
    expect(data.passwordResetToken).toBeNull();
    expect(data.passwordResetExpires).toBeNull();
  });

  it('reset-password rejects an EXPIRED token and does not change anything', async () => {
    const raw = 'b'.repeat(64);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordResetToken: sha256(raw),
      passwordResetExpires: new Date(Date.now() - 1_000),
    });

    await expect(AuthService.resetPassword(raw, 'whatever-123')).rejects.toThrow(
      /invalid or expired/i
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('reset-password rejects an unknown/already-used token', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(AuthService.resetPassword('nope', 'whatever-123')).rejects.toThrow(
      /invalid or expired/i
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

// --- Session invalidation on password change -------------------------------

describe('AuthService.verifyToken session invalidation', () => {
  it('rejects a token minted BEFORE passwordChangedAt', async () => {
    const token = jwt.sign({ userId: 'u1', email: 'a@b.com' }, 'test-secret', {
      algorithm: 'HS256',
    });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      // Password changed 5s in the future relative to the token's iat.
      passwordChangedAt: new Date(Date.now() + 5_000),
    });

    await expect(AuthService.verifyToken(token)).rejects.toThrow(/password change/i);
  });

  it('accepts a token minted AFTER passwordChangedAt', async () => {
    const token = jwt.sign({ userId: 'u1', email: 'a@b.com' }, 'test-secret', {
      algorithm: 'HS256',
    });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordChangedAt: new Date(Date.now() - 60_000),
    });

    const payload = await AuthService.verifyToken(token);
    expect(payload.userId).toBe('u1');
  });

  it('rejects a token whose user no longer exists', async () => {
    const token = jwt.sign({ userId: 'gone', email: 'a@b.com' }, 'test-secret', {
      algorithm: 'HS256',
    });
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(AuthService.verifyToken(token)).rejects.toThrow(/no longer exists/i);
  });
});

// --- Password change requires current password -----------------------------

describe('AuthService.updatePassword', () => {
  it('requires the correct current password and stamps passwordChangedAt', async () => {
    const hash = await AuthService.hashPassword('old-password');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', password: hash });
    prismaMock.user.update.mockResolvedValue({});

    await AuthService.updatePassword('u1', 'old-password', 'new-password-123');

    const data = prismaMock.user.update.mock.calls[0][0].data;
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    expect(typeof data.password).toBe('string');
  });

  it('rejects a wrong current password', async () => {
    const hash = await AuthService.hashPassword('old-password');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', password: hash });

    await expect(
      AuthService.updatePassword('u1', 'wrong-password', 'new-password-123')
    ).rejects.toThrow(/incorrect/i);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

// --- Self-service deletion requires current password -----------------------

describe('AuthService.deleteAccount', () => {
  it('deletes the user when the current password matches', async () => {
    const hash = await AuthService.hashPassword('correct-horse');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', password: hash });
    prismaMock.user.delete.mockResolvedValue({});

    await AuthService.deleteAccount('u1', 'correct-horse');

    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('refuses to delete on a wrong current password', async () => {
    const hash = await AuthService.hashPassword('correct-horse');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', password: hash });

    await expect(AuthService.deleteAccount('u1', 'not-the-password')).rejects.toThrow(
      /incorrect/i
    );
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
  });
});
