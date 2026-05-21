import { isAbsolute, resolve } from "node:path";
import type {
	CommandExecutionResult,
	RunnerSandbox,
	RuntimeRepositoryConfig,
} from "../types.js";

export interface MaterializeRepositoryResult {
	source: string;
	resolvedSource: string;
	mountPath: string;
	branch?: string;
	depth?: number;
	cloneStdout: string;
	cloneStderr: string;
	checkoutStdout?: string;
	checkoutStderr?: string;
	exitCode: number;
}

/**
 * Run `git clone` inside the sandbox to materialize the working tree at
 * `mountPath`. Local-path sources are rewritten to `file://...` so git
 * preserves repository semantics rather than collapsing them. If `branch`
 * is set, a follow-up `git -C <mountPath> checkout <branch>` runs so
 * non-default refs (including tags and SHAs) work uniformly.
 *
 * Authentication is delegated to the sandbox: the runtime does not inject
 * credentials. Callers who need auth should supply a tokenized HTTPS URL
 * in `source` or pre-materialize an SSH config / GIT_ASKPASS helper via
 * `files` and `env`.
 */
export async function materializeRepositoryIntoSandbox(
	repository: RuntimeRepositoryConfig,
	sandbox: RunnerSandbox,
	commandEnv: Record<string, string> = {},
): Promise<MaterializeRepositoryResult> {
	const resolvedSource = resolveSource(repository.source);
	const access = repository.access ?? "readwrite";
	const depth = repository.depth ?? (access === "read" ? 1 : undefined);

	// When the clone is shallow (`--depth N`), a post-clone `git checkout` of
	// a non-default branch fails — only the default branch's history is
	// fetched. So in that case we steer the clone with `--branch <ref>` and
	// skip the separate checkout. With a full clone, the post-clone checkout
	// path still handles tags and arbitrary SHAs that `--branch` rejects.
	const useBranchOnClone = Boolean(repository.branch && depth !== undefined);

	const cloneParts = ["git", "clone"];
	if (depth !== undefined) cloneParts.push("--depth", String(depth));
	if (useBranchOnClone && repository.branch) {
		cloneParts.push("--branch", shellQuote(repository.branch));
	}
	cloneParts.push(shellQuote(resolvedSource), shellQuote(repository.mountPath));
	const cloneCommand = cloneParts.join(" ");

	const cloneResult = await sandbox.runCommand(cloneCommand, {
		env: commandEnv,
	});
	if (cloneResult.exitCode !== 0) {
		throw new Error(
			`git clone failed for ${repository.source} (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`,
		);
	}

	let checkoutResult: CommandExecutionResult | undefined;
	if (repository.branch && !useBranchOnClone) {
		checkoutResult = await sandbox.runCommand(
			`git -C ${shellQuote(repository.mountPath)} checkout ${shellQuote(repository.branch)}`,
			{ env: commandEnv },
		);
		if (checkoutResult.exitCode !== 0) {
			throw new Error(
				`git checkout ${repository.branch} failed (exit ${checkoutResult.exitCode}): ${checkoutResult.stderr}`,
			);
		}
	}

	return {
		source: repository.source,
		resolvedSource,
		mountPath: repository.mountPath,
		branch: repository.branch,
		depth,
		cloneStdout: cloneResult.stdout,
		cloneStderr: cloneResult.stderr,
		checkoutStdout: checkoutResult?.stdout,
		checkoutStderr: checkoutResult?.stderr,
		exitCode: 0,
	};
}

function resolveSource(source: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
	if (source.startsWith("git@")) return source;
	const absolute = isAbsolute(source) ? source : resolve(process.cwd(), source);
	return `file://${absolute}`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
