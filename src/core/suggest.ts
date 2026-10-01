/**
 * "Did you mean": the known name a slip away from the one written. The same
 * measure as Menu Core's checks (`suggestion()` of @amxts/menu-core's
 * `src/menu-file.ts`), so the editor suggests what the server console would.
 */

/** How many letters to add, remove, change or swap to turn one word into the other, case aside. */
export function distance(a: string, b: string) {
	const x = a.toLowerCase().split("");
	const y = b.toLowerCase().split("");
	let before: number[] = [];
	let previous: number[] = [];
	for (let j = 0; j <= y.length; j++) previous.push(j);
	for (let i = 1; i <= x.length; i++) {
		const current = [i];
		for (let j = 1; j <= y.length; j++) {
			const cost = x[i - 1] == y[j - 1] ? 0 : 1;
			let best = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			const swapped = i > 1 && j > 1 && x[i - 1] == y[j - 2] && x[i - 2] == y[j - 1];
			if (swapped) best = Math.min(best, before[j - 2] + 1);
			current.push(best);
		}
		before = previous;
		previous = current;
	}
	return previous[y.length];
}

/** The known name a slip away from `name`; undefined when none is that close. */
export function closest(name: string, known: Iterable<string>) {
	let best = "";
	let bestDistance = Infinity;
	for (const each of known) {
		const away = distance(name, each);
		if (away >= bestDistance) continue;
		best = each;
		bestDistance = away;
	}
	const limit = name.length <= 4 ? 1 : Math.max(2, Math.floor(name.length / 4));
	if (bestDistance <= limit) return best;
	return [...known].filter(each => wordAdded(name, each)).sort((a, b) => a.length - b.length)[0];
}

/** Whether `longer` is `name` with a word added before or after it, case aside: ADMIN - IS_ADMIN. */
function wordAdded(name: string, longer: string) {
	const upper = name.toUpperCase();
	const other = longer.toUpperCase();
	return other.endsWith(`_${upper}`) || other.startsWith(`${upper}_`);
}

/** ` - did you mean "NAME"?`, or "" - as Menu Core words it. */
export function didYouMean(suggested: string | undefined) {
	return suggested != null ? ` - did you mean "${suggested}"?` : "";
}
