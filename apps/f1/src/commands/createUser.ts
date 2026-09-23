/**
 * Create User command - Add a human to the in-memory F1 workspace
 *
 * Lets a test drive simulate several Linear users on one issue: pass the
 * returned ID as `--as-user` to `start-session`, `prompt-session` or
 * `create-comment` to act as that person (per-prompter credential drives).
 */

import { Command } from "commander";
import { error, success } from "../utils/colors.js";
import { formatKeyValue } from "../utils/output.js";
import { printRpcUrl, rpcCall } from "../utils/rpc.js";

interface CreateUserResult {
	user: { id: string; name: string; email: string };
}

interface CreateUserParams {
	id?: string;
	name: string;
	email?: string;
}

export function createCreateUserCommand(): Command {
	const cmd = new Command("create-user");

	cmd
		.description(
			"Create an additional user in the F1 workspace (for multi-prompter test drives)",
		)
		.requiredOption("-n, --name <name>", "Display name of the user")
		.option(
			"-e, --email <email>",
			"Email address (defaults to <slug>@example.com)",
		)
		.option("--id <id>", "Stable user ID (defaults to user-<slug>)")
		.action(async (options: { name: string; email?: string; id?: string }) => {
			printRpcUrl();

			const params: CreateUserParams = {
				name: options.name,
				...(options.email && { email: options.email }),
				...(options.id && { id: options.id }),
			};

			try {
				const result = await rpcCall<CreateUserResult>("createUser", params);

				console.log(success("User created successfully"));
				console.log(`  ${formatKeyValue("User ID", result.user.id)}`);
				console.log(`  ${formatKeyValue("Name", result.user.name)}`);
				console.log(`  ${formatKeyValue("Email", result.user.email)}`);
				console.log(
					`  Use ${formatKeyValue("--as-user", result.user.id)} with start-session / prompt-session / create-comment`,
				);
			} catch (err) {
				if (err instanceof Error) {
					console.error(error(`Failed to create user: ${err.message}`));
					console.error("  Please check that:");
					console.error("    - The user ID is not already taken");
					console.error("    - The F1 server is running");
					process.exit(1);
				}
				throw err;
			}
		});

	return cmd;
}
