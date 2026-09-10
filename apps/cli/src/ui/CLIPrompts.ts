import readline from "node:readline";

/**
 * Utility namespace for CLI prompts and user interaction
 */
export namespace CLIPrompts {
	/**
	 * Ask a question and return the user's answer
	 */
	export async function ask(prompt: string): Promise<string> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		return new Promise((resolve) => {
			rl.question(prompt, (answer) => {
				rl.close();
				resolve(answer.trim());
			});
		});
	}

	/**
	 * Ask for a secret without echoing it. Keystrokes are masked so the value
	 * never lands in the terminal scrollback or shell history. Falls back to
	 * reading one line from stdin when stdin is not a TTY (piped input).
	 */
	export async function askSecret(prompt: string): Promise<string> {
		if (!process.stdin.isTTY) {
			// Piped: read a single line, no echo concerns.
			return (await CLIPrompts.ask(prompt)).trim();
		}
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		// Mute echo while the secret is typed (readline writes the prompt itself).
		const mutable = rl as unknown as {
			_writeToOutput?: (s: string) => void;
			output: NodeJS.WritableStream;
		};
		const originalWrite = mutable._writeToOutput;
		let muted = false;
		mutable._writeToOutput = (s: string) => {
			if (!muted) {
				originalWrite?.call(rl, s);
				return;
			}
			// Show a bullet per keystroke; swallow everything else.
			if (s.includes("\n")) mutable.output.write("\n");
			else if (s.length === 1) mutable.output.write("•");
		};
		return new Promise((resolve) => {
			rl.question(prompt, (answer) => {
				muted = false;
				rl.close();
				resolve(answer.trim());
			});
			muted = true;
		});
	}

	/**
	 * Ask a yes/no question
	 */
	export async function confirm(
		prompt: string,
		defaultValue = false,
	): Promise<boolean> {
		const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
		const answer = await CLIPrompts.ask(prompt + suffix);

		if (!answer) {
			return defaultValue;
		}

		return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
	}

	/**
	 * Display a menu and get user selection
	 */
	export async function menu(
		title: string,
		options: string[],
	): Promise<number | null> {
		console.log(`\n${title}`);
		console.log("─".repeat(50));

		options.forEach((option, index) => {
			console.log(`${index + 1}. ${option}`);
		});

		const answer = await CLIPrompts.ask("\nYour choice: ");
		const choice = parseInt(answer, 10);

		if (Number.isNaN(choice) || choice < 1 || choice > options.length) {
			return null;
		}

		return choice - 1;
	}
}
