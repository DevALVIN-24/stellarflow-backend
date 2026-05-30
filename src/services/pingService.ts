import axios from "axios";
import logger from "../utils/logger";
import dotenv from "dotenv";

dotenv.config();

export class PingService {
  private activePool: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor() {
    // Populate active pool initially with configured servers to avoid cold start issues
    const servers = this.remoteServers;
    for (const server of servers) {
      this.activePool.add(server);
    }
  }

  /**
   * Dynamically retrieve configured remote servers from environment.
   * This ensures we always use fresh configuration.
   */
  get remoteServers(): string[] {
    const remoteServersEnv = process.env.REMOTE_ORACLE_SERVERS || "";
    return remoteServersEnv
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
  }

  /**
   * Proactively ping a single relayer to check responsiveness.
   * Relayer must respond to GET /ping within 500ms.
   */
  async pingRelayer(url: string): Promise<boolean> {
    const startTime = Date.now();
    try {
      const pingUrl = url.endsWith('/') ? `${url}ping` : `${url}/ping`;
      const response = await axios.get(pingUrl, {
        timeout: 500,
        headers: {
          "User-Agent": "StellarFlow-Oracle/1.0",
        },
      });
      const latency = Date.now() - startTime;
      if (response.status >= 200 && response.status < 300 && latency <= 500) {
        this.activePool.add(url);
        logger.debug(`[PingService] Relayer ${url} is healthy (${latency}ms)`);
        return true;
      }
    } catch (error) {
      // network error, timeout, or non‑2xx response
    }
    this.activePool.delete(url);
    logger.warn(`[PingService] Relayer ${url} is unresponsive or slow (>500ms)`);
    return false;
  }

  /**
   * Ping all configured relayers concurrently and update the active pool.
   */
  async pingAll(): Promise<void> {
    const servers = this.remoteServers;
    if (servers.length === 0) {
      return;
    }

    logger.debug(`[PingService] Proactively pinging ${servers.length} configured relayers...`);
    await Promise.all(servers.map((url) => this.pingRelayer(url)));
  }

  /**
   * Start the periodic background ping monitoring loop.
   */
  async start(intervalMs?: number): Promise<void> {
    if (this.isRunning) {
      logger.warn("[PingService] Service is already running");
      return;
    }

    const defaultInterval = parseInt(process.env.RELAYER_PING_INTERVAL_MS || "30000", 10);
    const interval = intervalMs ?? (isNaN(defaultInterval) ? 30000 : defaultInterval);

    this.isRunning = true;
    logger.info(`[PingService] Started proactive relayer checks every ${interval}ms`);

    // Perform an initial check immediately
    await this.pingAll().catch((err) => {
      logger.error("[PingService] Initial ping check failed:", err);
    });

    this.pingInterval = setInterval(async () => {
      try {
        await this.pingAll();
      } catch (err) {
        logger.error("[PingService] Error during periodic ping:", err);
      }
    }, interval);
  }

  /**
   * Stop the periodic background ping monitoring loop.
   */
  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.isRunning = false;
    logger.info("[PingService] Stopped");
  }

  /**
   * Get the current active pool of responsive relayers.
   */
  getActivePool(): string[] {
    return Array.from(this.activePool);
  }

  /**
   * Check if a specific relayer is in the active pool.
   */
  isRelayerActive(url: string): boolean {
    return this.activePool.has(url);
  }

  /**
   * Get the current status of the service (for stats / monitoring).
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activePoolSize: this.activePool.size,
      activePool: this.getActivePool(),
      configuredRelayers: this.remoteServers,
    };
  }
}

// Export singleton instance
export const pingService = new PingService();
