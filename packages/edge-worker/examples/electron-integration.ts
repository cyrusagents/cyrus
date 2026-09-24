/**
 * Example: Electron Integration with EdgeWorker
 *
 * Shows how the Electron app would integrate the EdgeWorker with:
 * - User OAuth flow
 * - UI updates via IPC
 * - System notifications
 */

import { app, type BrowserWindow, ipcMain, Notification } from "electron";
import { EdgeWorker } from "miko-edge-worker";

export async function createElectronEdgeWorker(
	mainWindow: BrowserWindow,
	userToken: string,
	proxyUrl: string,
) {
	// Get Claude path based on platform
	const claudePath =
		process.platform === "darwin"
			? "/Applications/Claude.app/Contents/MacOS/claude"
			: process.platform === "win32"
				? "C:\\Program Files\\Claude\\claude.exe"
				: "/usr/local/bin/claude";

	// Create EdgeWorker with Electron-specific configuration
	const edgeWorker = new EdgeWorker({
		// Simple config - token from user OAuth flow
		proxyUrl: proxyUrl,
		linearToken: userToken,
		claudePath: claudePath,
		workspaceBaseDir: path.join(app.getPath("userData"), "workspaces"),

		// Electron-specific handlers for UI integration
		handlers: {
			// Send Claude events to renderer for UI updates
			onClaudeEvent: (issueId, event) => {
				mainWindow.webContents.send("claude-event", {
					issueId,
					event,
					timestamp: new Date().toISOString(),
				});

				// Track tool usage for UI
				if (event.type === "tool" && "tool_name" in event) {
					mainWindow.webContents.send("tool-usage", {
						issueId,
						tool: event.tool_name,
						timestamp: new Date().toISOString(),
					});
				}
			},

			// Show system notification when starting
			onSessionStart: (issueId, issue) => {
				new Notification({
					title: "Processing Linear Issue",
					body: `Working on ${issue.identifier}: ${issue.title}`,
					icon: path.join(__dirname, "../assets/icon.png"),
				}).show();

				// Update UI state
				mainWindow.webContents.send("session-started", {
					issueId,
					issue,
				});
			},

			// Update UI when session ends
			onSessionEnd: (issueId, exitCode) => {
				mainWindow.webContents.send("session-ended", {
					issueId,
					exitCode,
					success: exitCode === 0,
				});

				// Show completion notification
				new Notification({
					title: exitCode === 0 ? "Issue Processed" : "Processing Failed",
					body:
						exitCode === 0
							? `Successfully processed issue`
							: `Failed to process issue (code: ${exitCode})`,
					icon: path.join(__dirname, "../assets/icon.png"),
				}).show();
			},

			// Show error notifications
			onError: (error, context) => {
				console.error("EdgeWorker error:", error);

				// Send to renderer for error display
				mainWindow.webContents.send("edge-error", {
					message: error.message,
					context,
					timestamp: new Date().toISOString(),
				});

				// Show system notification for critical errors
				if (
					error.message.includes("Authentication") ||
					error.message.includes("token")
				) {
					new Notification({
						title: "Authentication Error",
						body: "Please re-authenticate with Linear",
						urgency: "critical",
					}).show();
				}
			},
		},
	});

	// Listen for renderer requests
	ipcMain.handle("get-active-sessions", () => {
		return edgeWorker.getActiveSessions();
	});

	ipcMain.handle("get-connection-status", () => {
		return edgeWorker.getConnectionStatus();
	});

	// Forward EdgeWorker events to renderer
	edgeWorker.on("connected", () => {
		mainWindow.webContents.send("edge-connected");
	});

	edgeWorker.on("disconnected", (reason) => {
		mainWindow.webContents.send("edge-disconnected", { reason });
	});

	edgeWorker.on("claude:response", (issueId, text) => {
		mainWindow.webContents.send("claude-response", {
			issueId,
			text,
			timestamp: new Date().toISOString(),
		});
	});

	return edgeWorker;
}

// Usage in main process
export async function setupEdgeWorker(mainWindow: BrowserWindow) {
	// Listen for OAuth completion from renderer
	ipcMain.handle("start-edge-worker", async (_event, { token, proxyUrl }) => {
		try {
			const edgeWorker = await createElectronEdgeWorker(
				mainWindow,
				token,
				proxyUrl,
			);
			await edgeWorker.start();

			// Store reference for cleanup
			(global as any).edgeWorker = edgeWorker;

			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error.message,
			};
		}
	});

	// Handle app shutdown
	app.on("before-quit", async () => {
		const edgeWorker = (global as any).edgeWorker;
		if (edgeWorker) {
			await edgeWorker.stop();
		}
	});
}
