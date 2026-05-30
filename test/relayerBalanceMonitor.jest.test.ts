import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Keypair } from "@stellar/stellar-sdk";

const sourceKeypair = Keypair.random();
const fakeServer = {
  root: jest.fn(),
  loadAccount: jest.fn(),
  ledgers: jest.fn(),
};

// Stream mock helpers
let streamCallback: ((ledger: any) => void) | null = null;
let streamErrorCallback: ((err: any) => void) | null = null;
const closeStreamSpy = jest.fn();

fakeServer.ledgers.mockReturnValue({
  cursor: jest.fn().mockReturnThis(),
  stream: jest.fn().mockImplementation((options: any) => {
    streamCallback = options.onmessage;
    streamErrorCallback = options.onerror;
    return closeStreamSpy;
  }),
} as any);

jest.unstable_mockModule("../src/lib/stellarProvider", () => ({
  default: {
    getServer: () => fakeServer,
    reportFailure: jest.fn(),
  },
}));

jest.unstable_mockModule("../src/signer", () => ({
  signer: {
    getPublicKey: jest.fn(async () => sourceKeypair.publicKey()),
  },
}));

const warnSpy = jest.fn();
const infoSpy = jest.fn();
const errorSpy = jest.fn();

jest.unstable_mockModule("../src/utils/logger", () => ({
  logger: {
    warn: warnSpy,
    info: infoSpy,
    error: errorSpy,
  },
}));

const { RelayerBalanceMonitorService } = await import("../src/services/relayerBalanceMonitor");

describe("RelayerBalanceMonitorService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    streamCallback = null;
    streamErrorCallback = null;

    fakeServer.root.mockResolvedValue({
      history_latest_ledger_sequence: 1000,
    } as any);

    fakeServer.loadAccount.mockResolvedValue({
      balances: [
        { asset_type: "native", balance: "100.0" }
      ]
    } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("checks balance on startup and logs normally when balance is above threshold", async () => {
    const monitor = new RelayerBalanceMonitorService();
    await monitor.start();

    expect(fakeServer.root).toHaveBeenCalled();
    expect(fakeServer.loadAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Relayer wallet balance: 100 XLM"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("HIGH PRIORITY"));
    expect(monitor.getStatus()).toEqual({
      isRunning: true,
      balanceThresholdXLM: 50,
      lastCheckedLedger: 1000,
    });

    monitor.stop();
  });

  it("triggers high-priority warning log when balance is below threshold", async () => {
    fakeServer.loadAccount.mockResolvedValue({
      balances: [
        { asset_type: "native", balance: "45.0" }
      ]
    } as any);

    const monitor = new RelayerBalanceMonitorService();
    await monitor.start();

    expect(fakeServer.loadAccount).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("🚨 HIGH PRIORITY: Relayer wallet"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Current: 45 XLM, Threshold: 50 XLM"));

    monitor.stop();
  });

  it("triggers balance check when ledger sequence advances by 100 ledgers", async () => {
    const monitor = new RelayerBalanceMonitorService();
    await monitor.start();

    // Reset calls count to count only subsequent ones
    fakeServer.loadAccount.mockClear();

    expect(streamCallback).toBeDefined();

    // Advance by 50 ledgers (from 1000 to 1050) -> should not trigger check
    streamCallback!({ sequence: 1050 });
    expect(fakeServer.loadAccount).not.toHaveBeenCalled();

    // Advance by 100 ledgers (from 1000 to 1100) -> should trigger check
    streamCallback!({ sequence: 1100 });
    expect(fakeServer.loadAccount).toHaveBeenCalled();

    monitor.stop();
    expect(closeStreamSpy).toHaveBeenCalled();
  });
});
