import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export function JumpToBottom({ onClick }) {
	return (
		<button
			type="button"
			className="jump-to-bottom"
			onClick={onClick}
			title="Jump to bottom and follow new logs"
			aria-label="Jump to bottom and follow new logs"
		>
			<HugeiconsIcon
				icon={ArrowDown01Icon}
				size={18}
				strokeWidth={2}
				aria-hidden="true"
				focusable="false"
			/>
		</button>
	);
}

export function isAboveBottom({ scrollHeight, scrollTop, clientHeight }) {
	return scrollHeight - scrollTop - clientHeight > 2;
}
