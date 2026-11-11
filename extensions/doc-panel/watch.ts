/**
 * Watch one file for changes, robustly enough for real editors.
 *
 * Watching the file itself is not enough: an editor that saves atomically
 * writes a temporary file and renames it over the original, so the inode being
 * watched is gone and the watch goes silent after the first save. A file that
 * is deleted and recreated does the same. So the **directory** is watched, and
 * events are filtered by the file's name; whatever the editor does, the name
 * keeps arriving.
 *
 * Events come in bursts (a rename is two, a write can be several), so they are
 * debounced, and the callback reads the file itself: this module reports
 * "something happened to that name", never what.
 */

import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";

export interface FileWatch {
	close(): void;
}

/**
 * Call `onChange` (debounced) whenever `path` may have changed, and `onError`
 * if the watch itself fails (its directory removed, say). Never throws: a
 * directory that can't be watched is reported through `onError` and the
 * returned watch is inert.
 */
export function watchFile(
	path: string,
	onChange: () => void,
	onError: (error: Error) => void,
	debounceMs = 80,
): FileWatch {
	const name = basename(path);
	let timer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;
	let closed = false;

	const fire = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			if (!closed) onChange();
		}, debounceMs);
	};

	try {
		watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
			// `filename` can be null on some platforms; then any event might be ours.
			if (filename === null || filename === undefined || filename.toString() === name) fire();
		});
		watcher.on("error", (error) => {
			if (!closed) onError(error);
		});
	} catch (error) {
		onError(error instanceof Error ? error : new Error(String(error)));
	}

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			watcher?.close();
		},
	};
}
