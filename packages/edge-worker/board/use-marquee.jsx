import { useEffect, useRef, useState } from "react";
import { marqueeSelection } from "./activity-selection.mjs";

export function useMarquee({
	list,
	rowNodes,
	selected,
	setSelected,
	stopFollowing,
	scope,
}) {
	const [box, setBox] = useState(null);
	const drag = useRef(null),
		frame = useRef(0),
		blockClick = useRef(false),
		clearClick = useRef(0);
	const latest = useRef(null);
	latest.current = { selected, setSelected, stopFollowing };
	// biome-ignore lint/correctness/useExhaustiveDependencies: Changing filters or views cancels the current drag.
	useEffect(() => {
		function update() {
			const state = drag.current,
				element = list.current;
			if (!state?.active || !element) return;
			const viewport = element.getBoundingClientRect();
			const edge = 32;
			const speed =
				state.clientY < viewport.top + edge
					? -Math.min(18, (viewport.top + edge - state.clientY) / 3)
					: state.clientY > viewport.bottom - edge
						? Math.min(18, (state.clientY - viewport.bottom + edge) / 3)
						: 0;
			element.scrollTop += speed;
			const bounds = [...rowNodes.current].map(([key, node]) => {
				const rect = node.getBoundingClientRect();
				return {
					key,
					left: rect.left - viewport.left,
					right: rect.right - viewport.left,
					top: rect.top - viewport.top + element.scrollTop,
					bottom: rect.bottom - viewport.top + element.scrollTop,
				};
			});
			const height = Math.max(
				element.clientHeight,
				...bounds.map((row) => row.bottom),
			);
			const x = Math.max(
				0,
				Math.min(element.clientWidth, state.clientX - viewport.left),
			);
			const y = Math.max(
				0,
				Math.min(
					height,
					Math.max(
						0,
						Math.min(element.clientHeight, state.clientY - viewport.top),
					) + element.scrollTop,
				),
			);
			const rectangle = {
				left: Math.min(state.x, x),
				right: Math.max(state.x, x),
				top: Math.min(state.y, y),
				bottom: Math.max(state.y, y),
			};
			setBox((previous) =>
				previous &&
				Object.keys(rectangle).every((key) => previous[key] === rectangle[key])
					? previous
					: rectangle,
			);
			const next = marqueeSelection(bounds, rectangle, state.base);
			latest.current.setSelected((previous) =>
				previous.size === next.size &&
				[...previous].every((key) => next.has(key))
					? previous
					: next,
			);
		}
		function tick() {
			update();
			if (drag.current?.active) frame.current = requestAnimationFrame(tick);
		}
		function move(event) {
			const state = drag.current;
			if (!state || event.pointerId !== state.pointerId) return;
			state.clientX = event.clientX;
			state.clientY = event.clientY;
			if (
				!state.active &&
				Math.hypot(
					event.clientX - state.startX,
					event.clientY - state.startY,
				) >= 5
			) {
				state.active = true;
				latest.current.stopFollowing();
				window.getSelection()?.removeAllRanges();
				list.current?.focus({ preventScroll: true });
				list.current?.setPointerCapture(event.pointerId);
				frame.current = requestAnimationFrame(tick);
			}
			if (state.active) event.preventDefault();
		}
		function end(event) {
			const state = drag.current;
			if (
				!state ||
				(event.pointerId !== undefined && state.pointerId !== event.pointerId)
			)
				return;
			if (state.active) {
				if (event.type === "pointerup") {
					state.clientX = event.clientX;
					state.clientY = event.clientY;
					update();
				} else latest.current.setSelected(state.original);
				blockClick.current = true;
				clearTimeout(clearClick.current);
				clearClick.current = setTimeout(() => {
					blockClick.current = false;
				}, 0);
			}
			if (list.current?.hasPointerCapture(state.pointerId))
				list.current.releasePointerCapture(state.pointerId);
			drag.current = null;
			cancelAnimationFrame(frame.current);
			setBox(null);
		}
		function click(event) {
			if (blockClick.current) {
				event.preventDefault();
				event.stopPropagation();
				blockClick.current = false;
			}
		}
		document.addEventListener("pointermove", move, { passive: false });
		document.addEventListener("pointerup", end);
		document.addEventListener("pointercancel", end);
		document.addEventListener("click", click, true);
		return () => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", end);
			document.removeEventListener("pointercancel", end);
			document.removeEventListener("click", click, true);
			if (
				drag.current &&
				list.current?.hasPointerCapture(drag.current.pointerId)
			)
				list.current.releasePointerCapture(drag.current.pointerId);
			drag.current = null;
			cancelAnimationFrame(frame.current);
			clearTimeout(clearClick.current);
			setBox(null);
		};
	}, [list, rowNodes, scope]);
	function onPointerDown(event) {
		if (
			event.button !== 0 ||
			event.pointerType !== "mouse" ||
			!list.current ||
			event.target.closest(".row-select, .activity-detail, input, textarea, a")
		)
			return;
		const viewport = list.current.getBoundingClientRect();
		// Keep native scrolling when the scrollbar is grabbed.
		if (event.clientX >= viewport.left + list.current.clientWidth) return;
		event.preventDefault();
		const original = new Set(latest.current.selected);
		drag.current = {
			pointerId: event.pointerId,
			active: false,
			startX: event.clientX,
			startY: event.clientY,
			clientX: event.clientX,
			clientY: event.clientY,
			x: event.clientX - viewport.left,
			y: event.clientY - viewport.top + list.current.scrollTop,
			base:
				event.ctrlKey || event.metaKey || event.shiftKey ? original : new Set(),
			original,
		};
	}
	return { box, onPointerDown };
}
