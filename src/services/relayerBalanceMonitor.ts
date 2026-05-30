import { Horizon } from "@stellar/stellar-sdk";
import { signer } from "../signer";
import stellarProvider from "../lib/stellarProvider";
import { logger } from "../utils/logger";
import dotenv from "dotenv";

dotenv.config();

/**
 * RelayerBalanceMonitorService
 * Background service that monitors the relayer wallet's XLM balance.
 * Checks the balance every 100 ledgers and triggers a high-priority system
 * warning log if the balance drops below the threshold (default: 50 XLM).
 */
export class RelayerBalanceMonitorService {
  private server: Horizon.Server;
  private isRunning: boolean = false;
  private closeStream: (() => void) | null = null;
  private lastCheckedLedger: number = 0;
  private balanceThresholdXLM: number;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.server = stellarProvider.getServer();
    const threshold = parseFloat(process.env.RELAYER_BALANCE_ALERT_THRESHOLD_XLM || "50");
    this.balanceThresholdXLM = isNaN(threshold) ? 50 : threshold;
  }

  /**
   * Start the background balance monitor service.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("[RelayerBalanceMonitor] Service is already running");
      return;
    }

    this.isRunning = true;
    logger.info(`[RelayerBalanceMonitor] Started with threshold: ${this.balanceThresholdXLM} XLM`);

    // Perform an initial fetch of latest ledger sequence & check balance immediately
    try {
      this.server = stellarProvider.getServer();
      const root = await this.server.root();
      this.lastCheckedLedger = root.history_latest_ledger_sequence || 0;
      logger.info(`[RelayerBalanceMonitor] Initialized latest ledger sequence: ${this.lastCheckedLedger}`);
    } catch (err) {
      logger.error("[RelayerBalanceMonitor] Failed to fetch initial ledger sequence from Horizon:", err);
    }

    await this.checkBalance().catch((err) => {
      logger.error("[RelayerBalanceMonitor] Error during initial balance check:", err);
    });

    this.startStream();

    // Fallback timer: every 5 minutes, query server root to check if ledger has advanced by 100
    this.fallbackTimer = setInterval(() => {
      this.runFallbackCheck().catch((err) => {
        logger.error("[RelayerBalanceMonitor] Error in fallback check:", err);
      });
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop the background balance monitor service.
   */
  stop(): void {
    if (this.closeStream) {
      try {
        this.closeStream();
      } catch {}
      this.closeStream = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.isRunning = false;
    logger.info("[RelayerBalanceMonitor] Stopped");
  }

  /**
   * Start the ledger stream to count and react to closed ledgers.
   */
  private startStream(): void {
    if (!this.isRunning) return;

    try {
      this.server = stellarProvider.getServer();
      this.closeStream = this.server.ledgers()
        .cursor("now")
        .stream({
          onmessage: (ledger) => {
            const currentLedger = ledger.sequence;
            if (this.lastCheckedLedger === 0) {
              this.lastCheckedLedger = currentLedger;
            } else if (currentLedger - this.lastCheckedLedger >= 100) {
              logger.info(
                `[RelayerBalanceMonitor] 100 ledgers advanced (from ${this.lastCheckedLedger} to ${currentLedger}). Triggering balance check.`
              );
              this.lastCheckedLedger = currentLedger;
              this.checkBalance().catch((err) => {
                logger.error("[RelayerBalanceMonitor] Error in ledger-triggered balance check:", err);
              });
            }
          },
          onerror: (error) => {
            logger.warn("[RelayerBalanceMonitor] Ledger stream error, restarting stream in 10 seconds:", error);
            this.restartStream();
          }
        });
    } catch (err) {
      logger.error("[RelayerBalanceMonitor] Failed to start ledger stream, retrying in 10 seconds:", err);
      this.restartStream();
    }
  }

  /**
   * Safely restarts the ledger stream.
   */
  private restartStream(): void {
    if (this.closeStream) {
      try {
        this.closeStream();
      } catch {}
      this.closeStream = null;
    }
    setTimeout(() => {
      if (this.isRunning) {
        this.startStream();
      }
    }, 10000);
  }

  /**
   * Fallback poll that queries Horizon root to compare ledger sequence numbers.
   */
  private async runFallbackCheck(): Promise<void> {
    try {
      this.server = stellarProvider.getServer();
      const root = await this.server.root();
      const currentLedger = root.history_latest_ledger_sequence;
      if (currentLedger && (this.lastCheckedLedger === 0 || currentLedger - this.lastCheckedLedger >= 100)) {
        logger.info(
          `[RelayerBalanceMonitor] Fallback check: ${currentLedger - this.lastCheckedLedger} ledgers advanced. Triggering balance check.`
        );
        this.lastCheckedLedger = currentLedger;
        await this.checkBalance();
      }
    } catch (err) {
      logger.error("[RelayerBalanceMonitor] Failed fallback check Horizon root call:", err);
    }
  }

  /**
   * Check the balance of the relayer and log a high-priority warning if below threshold.
   */
  async checkBalance(): Promise<void> {
    try {
      this.server = stellarProvider.getServer();
      const publicKey = await signer.getPublicKey();
      
      const account = await this.server.loadAccount(publicKey);
      const xlmBalance = account.balances.find(
        (balance) => balance.asset_type === "native"
      );

      if (!xlmBalance) {
        logger.warn(`[RelayerBalanceMonitor] No native XLM balance found for relayer account: ${publicKey}`);
        return;
      }

      const balanceAmount = parseFloat(xlmBalance.balance);
      logger.info(`[RelayerBalanceMonitor] Relayer wallet balance: ${balanceAmount} XLM (threshold: ${this.balanceThresholdXLM} XLM)`);

      if (balanceAmount < this.balanceThresholdXLM) {
        logger.warn(
          `[SYSTEM_WARNING] [RelayerBalanceMonitor] 🚨 HIGH PRIORITY: Relayer wallet (${publicKey}) balance is extremely low! ` +
          `Current: ${balanceAmount} XLM, Threshold: ${this.balanceThresholdXLM} XLM. Price updates will stop completely if gas runs out!`
        );
      }
    } catch (err) {
      logger.error("[RelayerBalanceMonitor] Failed to check relayer balance:", err);
    }
  }

  /**
   * Get the current status of the service (useful for monitoring / testing).
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      balanceThresholdXLM: this.balanceThresholdXLM,
      lastCheckedLedger: this.lastCheckedLedger,
    };
  }
}

// Export singleton instance
export const relayerBalanceMonitorService = new RelayerBalanceMonitorService();
