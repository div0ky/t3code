import type { ComposerCommandItem } from "./ComposerCommandMenu";

const tagKey = (name: string) => name.trim().toLocaleLowerCase();

/**
 * Tags for what is typed after `#`. The closest name comes first, and among equals the tags the
 * thread lacks do, so Enter on `#act` adds a tag before it removes one.
 */
export function matchComposerTagItems(input: {
  readonly tags: readonly string[];
  /** Tags already on the thread; a new chat's may not be saved yet, so they are offered too. */
  readonly applied: readonly string[];
  readonly query: string;
}): Extract<ComposerCommandItem, { type: "tag" }>[] {
  const needle = tagKey(input.query);
  const appliedKeys = new Set(input.applied.map(tagKey));
  const storedKeys = new Set(input.tags.map(tagKey));
  const rank = (name: string) =>
    tagKey(name) === needle ? 0 : tagKey(name).startsWith(needle) ? 1 : 2;
  return [...input.tags, ...input.applied.filter((name) => !storedKeys.has(tagKey(name)))]
    .filter((name) => tagKey(name).includes(needle))
    .map((name) => ({ name, tagged: appliedKeys.has(tagKey(name)) }))
    .toSorted((a, b) => rank(a.name) - rank(b.name) || Number(a.tagged) - Number(b.tagged))
    .map(({ name, tagged }) => ({
      id: `tag:${tagKey(name)}`,
      type: "tag",
      name,
      tagged,
      label: `#${name}`,
      description: tagged ? "On this thread. Select to remove." : "Tag this thread",
    }));
}

/**
 * Whether Space takes the highlighted tag. Only a name that starts with what was typed counts, so
 * `# ` for a heading and a stray `#12 ` in prose still type a space.
 */
export function spaceTakesTag(query: string, name: string): boolean {
  return query.length > 0 && tagKey(name).startsWith(tagKey(query));
}
