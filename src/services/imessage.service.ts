import config from '../config';
import logger from '../utils/logger';

/**
 * iMessage delivery via the Spectrum TS cloud provider (issue #10).
 *
 * Design notes:
 * - Everything is gated behind `config.imessage.enabled`. With iMessage
 *   disabled (the default) this module never imports the SDK and never
 *   attempts a send, so the app compiles and runs normally without any
 *   Spectrum credentials.
 * - The Spectrum SDK is loaded LAZILY via dynamic `import()` the first time a
 *   send is actually attempted. The provider lives at
 *   `spectrum-ts/providers/imessage`, a package subpath whose types only
 *   resolve under `node16`/`bundler` moduleResolution. This project compiles
 *   with the classic `node` resolver, so the specifiers are held in variables
 *   and the surface we use is described by the small local adapter interfaces
 *   below. The real runtime shapes were verified against spectrum-ts@8.x.
 * - Sends are FAIL-SAFE: any provider/init error is caught and logged and a
 *   result object is returned. `sendIMessage` never throws, so a failing
 *   iMessage delivery can never break the other notification channels.
 */

export interface IMessageSendResult {
  ok: boolean;
  /** True when the send was short-circuited (disabled / not configured). */
  skipped?: boolean;
  /** Human-readable reason or provider message for logging. */
  detail?: string;
}

// --- Minimal local adapter for the pieces of the Spectrum SDK we call. ---
// See the moduleResolution note above for why these are declared locally
// instead of imported from `spectrum-ts/providers/imessage`.
interface SpectrumSpace {
  send(text: string): Promise<unknown>;
}
interface SpectrumPlatformInstance {
  space: { create(user: string): Promise<SpectrumSpace> };
}
interface SpectrumInstanceLike {
  stop(): Promise<void>;
}
interface ImessageProvider {
  (spectrum: SpectrumInstanceLike): SpectrumPlatformInstance;
  config(cfg?: Record<string, unknown>): unknown;
}
type SpectrumFactory = (options: {
  projectId?: string;
  projectSecret?: string;
  providers: unknown[];
}) => Promise<SpectrumInstanceLike>;

// Held in variables so tsc (classic `node` resolution) does not try to resolve
// the provider subpath's types at build time.
const SPECTRUM_MODULE = 'spectrum-ts';
const IMESSAGE_MODULE = 'spectrum-ts/providers/imessage';

class IMessageServiceImpl {
  private appP: Promise<{ instance: SpectrumInstanceLike; provider: ImessageProvider }> | null = null;

  /** Master feature gate. */
  isEnabled(): boolean {
    return config.imessage.enabled;
  }

  /**
   * True only when iMessage is enabled AND the selected mode has the creds it
   * needs. Cloud/dedicated require Spectrum project credentials; local (Mac
   * dev relay) does not. Callers must check this before sending.
   */
  isReady(): boolean {
    if (!config.imessage.enabled) return false;
    if (config.imessage.mode === 'local') return true;
    return Boolean(config.imessage.projectId && config.imessage.projectSecret);
  }

  /** Lazily initialize (and cache) the Spectrum cloud instance + provider. */
  private getApp(): Promise<{ instance: SpectrumInstanceLike; provider: ImessageProvider }> {
    if (!this.appP) {
      this.appP = (async () => {
        const { Spectrum } = (await import(SPECTRUM_MODULE)) as { Spectrum: SpectrumFactory };
        const { imessage } = (await import(IMESSAGE_MODULE)) as { imessage: ImessageProvider };

        // Cloud/dedicated use the project credentials; local mode runs the
        // Mac dev relay and needs neither.
        const providerConfig = config.imessage.mode === 'local' ? { local: true } : undefined;

        const instance = await Spectrum({
          projectId: config.imessage.projectId || undefined,
          projectSecret: config.imessage.projectSecret || undefined,
          providers: [imessage.config(providerConfig)],
        });
        logger.info(`iMessage (Spectrum) initialized in "${config.imessage.mode}" mode`);
        return { instance, provider: imessage };
      })();
      // If init fails, clear the cache so a later send can retry instead of
      // being wedged on a permanently-rejected promise.
      this.appP.catch(() => {
        this.appP = null;
      });
    }
    return this.appP;
  }

  /**
   * Send a plain-text iMessage to `address` (phone number or Apple-ID email).
   * NEVER throws — returns a result object the caller can log. When disabled
   * or unconfigured the call short-circuits with `{ ok: false, skipped: true }`.
   */
  async sendIMessage(address: string, text: string): Promise<IMessageSendResult> {
    if (!this.isReady()) {
      logger.warn('iMessage not ready (disabled or missing Spectrum credentials); skipping send');
      return {
        ok: false,
        skipped: true,
        detail: 'iMessage channel disabled or missing Spectrum credentials',
      };
    }

    try {
      const { instance, provider } = await this.getApp();
      const im = provider(instance);
      const space = await im.space.create(address);
      await space.send(text);
      logger.info(`iMessage sent to ${address}`);
      return { ok: true };
    } catch (err: any) {
      // Fail-safe: swallow so the notification worker's other channels survive.
      logger.error(`iMessage send failed for ${address}:`, err);
      return { ok: false, detail: err?.message ?? String(err) };
    }
  }

  // --- Verification flow (stub) ---------------------------------------------
  // Never send scheduled pings to an address that has not completed this flow
  // (callers gate on `user.imessageVerifiedAt`). A full implementation would
  // persist a hashed code + expiry and confirm it in-app (see issue #16's
  // email-verification code path); this stub wires the send half only.

  /** Six-digit numeric verification code. */
  generateVerificationCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /**
   * Send a verification code to a not-yet-verified address. Returns the code
   * so the caller can persist a hash of it. Fail-safe like `sendIMessage`.
   */
  async sendVerificationCode(
    address: string
  ): Promise<{ ok: boolean; code?: string; detail?: string }> {
    const code = this.generateVerificationCode();
    const res = await this.sendIMessage(
      address,
      `Your OnTheLoop verification code is ${code}. It expires in 10 minutes.`
    );
    return res.ok ? { ok: true, code } : { ok: false, detail: res.detail };
  }
}

export const IMessageService = new IMessageServiceImpl();
export default IMessageService;
