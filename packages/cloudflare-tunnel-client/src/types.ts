/**
 * Event emitted by CloudflareTunnelClient
 */
export interface CloudflareTunnelClientEvents {
	connect: () => void;
	connected: (connection: any) => void; // Emitted for each of the 4 tunnel connections
	disconnect: (reason: string) => void;
	error: (error: Error) => void;
	ready: (tunnelUrl: string) => void;
}

/**
 * Restart policy for a cloudflared child that exits after it had connected
 */
export interface CloudflareTunnelRecoveryOptions {
	/** Max time for a spawned child to report its first connection */
	connectTimeoutMs?: number;
	/** Delay before the first restart attempt; doubles per consecutive failure */
	initialRestartDelayMs?: number;
	/** Upper bound for the restart delay */
	maxRestartDelayMs?: number;
	/** Consecutive failed restarts before giving up (client stays disconnected) */
	maxRestartAttempts?: number;
	/** Connected duration after which an exit starts a fresh retry budget */
	stableConnectionMs?: number;
	/** Grace period after SIGINT before SIGKILL on deliberate disconnect */
	killGraceMs?: number;
	/** Max wait for a killed child to exit before restarting; recovery stops if exceeded */
	killWaitMs?: number;
}
