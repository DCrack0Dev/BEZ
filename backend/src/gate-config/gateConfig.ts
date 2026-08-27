import { getAllGateOverrides, upsertGateOverride } from '../database';
import { logger } from '../logging';

// Human-in-the-loop Gate Config: resolves every gate used by the validator.
// Values are ONLY written to the DB when a user explicitly approves a
// proposal; AI never writes here directly. Defaults come from tradingConfig /
// signalValidator (hardcoded, safe) unless an APPLIED override exists.
//
// NOTE: Keys are intentionally simple strings so the proposal engine can
// propose changes, the UI can render a list, and there is zero ambiguity
// about which gate is being discussed between model + user.
type GateValue = number | boolean;
type GateMeta = {
  defaultValue: GateValue;
  type: 'HARD_GATE' | 'SOFT_REQ' | 'FILTER' | 'THRESHOLD' | 'ENABLE';
  label: string;
  min?: number;
  max?: number;
};

export const GATE_DEFAULTS: Record<string, GateMeta> = {
  'hardGateThreshold':    { defaultValue: 3, type: 'THRESHOLD', label: 'Hard Gate Passing Threshold (out of 7)', min: 1, max: 7 },
  'softThreshold.buy':    { defaultValue: 2, type: 'THRESHOLD', label: 'BUY Soft Requirements (out of 12)', min: 1, max: 12 },
  'softThreshold.sell':   { defaultValue: 2, type: 'THRESHOLD', label: 'SELL Soft Requirements (out of 12)', min: 1, max: 12 },
  'filter.spread.enabled':  { defaultValue: 0, type: 'ENABLE',  label: 'Spread Hard Filter (0=off, 1=on)' },
  'filter.session.enabled': { defaultValue: 0, type: 'ENABLE',  label: 'Session Hard Filter (0=off, 1=on)' },
  'filter.rr.enabled':      { defaultValue: 0, type: 'ENABLE',  label: 'Risk/Reward Hard Filter (0=off, 1=on)' },
  'filter.rr.min':         { defaultValue: 1, type: 'THRESHOLD', label: 'Min RR Ratio if filter enabled', min: 0.5, max: 10 },
  'filter.rsi.min':        { defaultValue: 0.15, type: 'FILTER', label: 'RSI Min (0-1)', min: 0, max: 1 },
  'filter.rsi.max':        { defaultValue: 0.92, type: 'FILTER', label: 'RSI Max (0-1)', min: 0, max: 1 },
  'filter.adxTrend.min':   { defaultValue: 10, type: 'FILTER', label: 'ADX Trend Minimum', min: 0, max: 80 },
  'filter.bb.enabled':     { defaultValue: 0, type: 'ENABLE',  label: 'Bollinger Band Hard Filter' },
  'filter.volume.multiplier': { defaultValue: 0.5, type: 'THRESHOLD', label: 'Volume Spike Multiplier (applied on top of base)', min: 0.1, max: 5 },
  'structure.smcProximity.enabled': { defaultValue: 0, type: 'ENABLE', label: 'Require strict SMC (OB/FVG) Proximity Check' },
  'filter.winrateSimilar.enabled': { defaultValue: 0, type: 'ENABLE', label: 'Similar-Setup Winrate Hard Gate' },
  'structure.minStrength': { defaultValue: 0.25, type: 'THRESHOLD', label: 'Min Structure Strength to Consider Entry', min: 0, max: 1 },
  'trend.minStrength':    { defaultValue: 0.25, type: 'THRESHOLD', label: 'Min Trend Strength to Consider Entry', min: 0, max: 1 },
  'entry.cooldownSeconds.buy':  { defaultValue: 60, type: 'THRESHOLD', label: 'Min Seconds Between BUY Entries', min: 0, max: 3600 },
  'entry.cooldownSeconds.sell': { defaultValue: 60, type: 'THRESHOLD', label: 'Min Seconds Between SELL Entries', min: 0, max: 3600 },
};

export class GateConfig {
  private static _instance: GateConfig | null = null;
  private overrides: Record<string, { value: GateValue; note?: string }> = {};
  private loaded = false;

  static instance(): GateConfig {
    if (!GateConfig._instance) GateConfig._instance = new GateConfig();
    return GateConfig._instance;
  }

  async init(): Promise<void> {
    try {
      const rows = await getAllGateOverrides();
      const loaded: Record<string, { value: GateValue; note?: string }> = {};
      for (const r of rows) {
        const num = Number(r.currentValue);
        if (r.gateType === 'ENABLE') {
          loaded[r.gateKey] = { value: num >= 0.5, note: r.note || undefined };
        } else {
          loaded[r.gateKey] = { value: num, note: r.note || undefined };
        }
      }
      this.overrides = loaded;
      this.loaded = true;
      logger.success(`GateConfig loaded: ${Object.keys(this.overrides).length} approved override(s) active`);
    } catch (e) {
      logger.warn('GateConfig init failed — using safe defaults (approval DB down?).', e);
      this.overrides = {};
      this.loaded = true;
    }
  }

  private assertLoaded() {
    if (!this.loaded) {
      logger.warn('GateConfig used before init() — returning default values only');
    }
  }

  /**
   * Read a numeric gate, falling back to safe default if no override is
   * present. Clamped into the [min,max] range defined in GATE_DEFAULTS to
   * prevent an approved proposal from accidentally breaking the validator.
   */
  getNum(key: string): number {
    this.assertLoaded();
    const meta = GATE_DEFAULTS[key];
    if (!meta) {
      logger.error(`GateConfig: unknown gate key "${key}" — returning 0 (treat as disabled).`);
      return 0;
    }
    const override = this.overrides[key];
    let v: number;
    if (override !== undefined) {
      v = typeof override.value === 'boolean' ? (override.value ? 1 : 0) : Number(override.value);
    } else {
      v = typeof meta.defaultValue === 'boolean' ? (meta.defaultValue ? 1 : 0) : Number(meta.defaultValue);
    }
    if (meta.min !== undefined && v < meta.min) v = meta.min;
    if (meta.max !== undefined && v > meta.max) v = meta.max;
    return v;
  }

  getBool(key: string): boolean {
    return this.getNum(key) >= 0.5;
  }

  isOverridden(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.overrides, key);
  }

  overrideNote(key: string): string | undefined {
    return this.overrides[key]?.note;
  }

  allEntries(): Array<{
    key: string;
    type: string;
    label: string;
    defaultValue: GateValue;
    effectiveValue: GateValue;
    overridden: boolean;
    note?: string;
    min?: number;
    max?: number;
  }> {
    const out: ReturnType<GateConfig['allEntries']> = [];
    for (const key of Object.keys(GATE_DEFAULTS)) {
      const meta = GATE_DEFAULTS[key];
      const overridden = this.isOverridden(key);
      const effectiveValue = meta.type === 'ENABLE' ? this.getBool(key) : this.getNum(key);
      out.push({
        key,
        type: meta.type,
        label: meta.label,
        defaultValue: meta.defaultValue,
        effectiveValue,
        overridden,
        note: this.overrideNote(key),
        min: meta.min,
        max: meta.max,
      });
    }
    return out;
  }

  /**
   * Manual user override (API can expose this for settings screen too).
   * Always logged — AI never calls this.
   */
  async setManualOverride(
    key: string,
    desiredValue: GateValue,
    reviewedBy: 'USER' = 'USER',
    note?: string
  ): Promise<boolean> {
    const meta = GATE_DEFAULTS[key];
    if (!meta) {
      logger.error(`GateConfig.setManualOverride: unknown gate "${key}" — rejected`);
      return false;
    }
    const numVal = typeof desiredValue === 'boolean' ? (desiredValue ? 1 : 0) : Number(desiredValue);
    const defNum = typeof meta.defaultValue === 'boolean' ? (meta.defaultValue ? 1 : 0) : Number(meta.defaultValue);
    const res = await upsertGateOverride({
      gateKey: key,
      gateType: meta.type,
      label: meta.label,
      currentValue: numVal,
      defaultValue: defNum,
      modifiedBy: reviewedBy,
      note,
      enabled: true,
    });
    if (!res) return false;
    this.overrides[key] = {
      value: meta.type === 'ENABLE' ? numVal >= 0.5 : numVal,
      note,
    };
    logger.info(`GateConfig: user set ${key} → ${String(desiredValue)}`);
    return true;
  }

  /** Called by approveProposal() only when user clicks APPROVE on a proposal. */
  _applyApprovedProposal(key: string, value: GateValue, note?: string): void {
    const meta = GATE_DEFAULTS[key];
    if (!meta) return;
    this.overrides[key] = {
      value: meta.type === 'ENABLE' ? (typeof value === 'boolean' ? value : Number(value) >= 0.5)
                                   : (typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)),
      note,
    };
    logger.info(`GateConfig: applied APPROVED proposal → ${key}=${String(value)}`);
  }
}

export const gateConfig = GateConfig.instance();
