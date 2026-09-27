/**
 * The `.dsh-octopus` runtime skill: a plugin-bundled knowledge block the DSH
 * skill registry makes model-invocable, so the agent knows the format &amp;
 * workflow WITHOUT scanning for an example file. It rides this plugin (one
 * deploy); the host registers it via `ctx.skills.register(...)` at activation.
 *
 * Content is intentionally self-contained (the model loads it with the `skill`
 * tool when a task matches its description) and must stay in sync with the
 * parser + enforcement semantics in workspace-schema.ts / workspace-policy.ts.
 */

/** Structural mirror of the registry's accepted runtime skill definition (we
 *  do NOT import @deepseek-ai/dsh-skill — keeps the bundle dependency-free and
 *  mirrors how context-types.ts mirrors host services). The loader requires
 *  BOTH `source` (raw markdown) and `content` to be non-empty strings. */
export interface WorkspaceSkillDefinition {
  /** kebab-case name (the `skill` tool's `name` arg). */
  name: string
  /** Catalog one-liner (what the model sees in `<available_skills>`). */
  description: string
  /** Lower wins duplicate names; runtime skill rank is 250. */
  rank: number
  /** Invocation controls; both true makes it model- and user-invocable. */
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
  /** Raw markdown instructions body (the loader-required `source`). */
  source: string
  /** Markdown instructions body (the skill's `<skill_content>`). */
  content: string
}

/** The markdown body shared by `source` and `content`. */
const WORKSPACE_SKILL_BODY = [
  '# DSH operation space (.dsh-octopus)',
  '',
  'A `*.dsh-octopus` file defines a DSH "operation space" (章鱼作业区): a list of folders the sidebar shows, each with an explicit read/write permission. Use this skill whenever you create or edit such a file — do not invent the format or search the workspace for an example.',
  '',
  '## Format (JSONC — comments and trailing commas are allowed)',
  '```jsonc',
  '{',
  '  "version": 1,',
  '  "name": "My operation space",     // optional; the operation-space tab title',
  '  "folders": [',
  '    { "path": "C:/repo/a", "access": "readWrite" },',
  '    { "path": "./docs" },            // relative to THIS file\'s directory',
  '    "C:/repo/b"                       // string shorthand (default access)',
  '  ],',
  '  "settings": {',
  '    "defaultAccess": "readOnly",     // readWrite | readOnly (default readOnly)',
  '    "autoActivate": true             // found in the session cwd => apply it (default true)',
  '  }',
  '}',
  '```',
  '',
  '## Rules',
  '- Per-folder `access`: `readWrite` or `readOnly`. **Unlabeled folders default to `readOnly`** (security-first) unless `settings.defaultAccess` flips it.',
  '- Relative `path` values resolve against the manifest file\'s own directory.',
  '- `folders` must be a non-empty array; each entry is a path string or `{path, name?, access?}`.',
  '- Absolute paths from other drives/shares are allowed (Windows, UNC).',
  '- `.dsh-workspace` is still accepted as a legacy alias for the extension.',
  '',
  '## Applying changes (important)',
  '- The file is the single source of truth. Opening the operation-space tab SCANS the session cwd one level for `*.dsh-octopus` and applies it when it is the only manifest there and does not set `settings.autoActivate: false`; with several candidates the tab lists them and the user picks one. So a manifest placed at the session cwd needs no hand-typed path.',
  '- After you create or edit such a file at the session cwd, tell the user to open (or re-open) the operation-space tab. A manifest that lives elsewhere still needs its path pasted into that panel, whose refresh icon re-applies the active manifest.',
  '- The session cwd is auto-included as an implicit readWrite root unless the manifest lists it (then its listed access wins).',
  '- Which folders are ACTUALLY granted right now is answered by the `octopus_space` tool, never by guessing: it returns every declared root of the active space with its label, absolute path, read/write access and whether it exists. Call it before acting on a folder the user names by label alone ("rw", "现场问题"), and whenever the answer depends on which roots are read-only.',
  '- Model native tools are still sandboxed to the session cwd; folders outside it (e.g. Desktop) are reachable by the operation space, not by the model\'s tools.',
  '',
  '## Common asks',
  '- "把这些目录建成作业区（目录1/2 读写、目录3 只读）" → create a `.dsh-octopus` with those `folders` and the right `access`.',
  '- "把权限改成读写 / 加一个目录 / 删一个目录" → edit the matching `folders` entry, keep the rest intact, then ask the user to re-apply.',
  '- "rw 里有什么 / 看下现场问题那个目录" → the label is the manifest\'s, so call `octopus_space` first and use the absolute path it reports.',
].join('\n')

/** The runtime skill this plugin registers for `*.dsh-octopus`. */
export const WORKSPACE_SKILL: WorkspaceSkillDefinition = {
  name: 'dsh-octopus',
  rank: 250,
  invocation: { modelInvocable: true, userInvocable: true },
  description: 'Create or edit a DSH operation space (.dsh-octopus) file; loading this skill teaches the exact JSONC schema, per-folder read/write semantics, and how to apply changes.',
  source: WORKSPACE_SKILL_BODY,
  content: WORKSPACE_SKILL_BODY,
}
