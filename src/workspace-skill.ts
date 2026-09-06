/**
 * The `.dsh-workspace` runtime skill: a plugin-bundled knowledge block the
 * DSH skill registry makes model-invocable, so the agent knows the format &amp;
 * workflow WITHOUT scanning for an example file. It rides this plugin (one
 * deploy); the host registers it via `ctx.skills.register(...)` at activation.
 *
 * Content is intentionally self-contained (the model loads it with the `skill`
 * tool when a task matches its description) and must stay in sync with the
 * parser + enforcement semantics in workspace-schema.ts / workspace-policy.ts.
 */

/** Structural mirror of the registry's accepted runtime skill definition
 *  (we do NOT import @deepseek-ai/dsh-skill — keeps the bundle dependency-free
 *  and mirrors how context-types.ts mirrors host services). */
export interface WorkspaceSkillDefinition {
  /** kebab-case name (the `skill` tool's `name` arg). */
  name: string
  /** Catalog one-liner (what the model sees in `<available_skills>`). */
  description: string
  /** Lower wins duplicate names; runtime skill rank is 250. */
  rank: number
  /** Invocation controls; both true makes it model- and user-invocable. */
  invocation?: { modelInvocable: boolean; userInvocable: boolean }
  /** Markdown instructions body (the skill's `<skill_content>`). */
  content: string
}

/** The runtime skill the sidebar plugin registers for `*.dsh-workspace`. */
export const WORKSPACE_SKILL: WorkspaceSkillDefinition = {
  name: 'dsh-workspace',
  rank: 250,
  invocation: { modelInvocable: true, userInvocable: true },
  description: 'Create or edit a DSH multi-root workspace (.dsh-workspace) file; loading this skill teaches the exact JSONC schema, per-folder read/write semantics, and how to apply changes.',
  content: [
    '# DSH multi-root workspace (.dsh-workspace)',
    '',
    'A `*.dsh-workspace` file defines a DSH "multi-root workspace": a list of folders the sidebar shows, each with an explicit read/write permission. Use this skill whenever you create or edit such a file — do not invent the format or search the workspace for an example.',
    '',
    '## Format (JSONC — comments and trailing commas are allowed)',
    '```jsonc',
    '{',
    '  "version": 1,',
    '  "name": "My workspace",            // optional; the workspace bar + files-window tab title',
    '  "folders": [',
    '    { "path": "C:/repo/a", "access": "readWrite" },',
    '    { "path": "./docs" },            // relative to THIS file\'s directory',
    '    "C:/repo/b"                       // string shorthand (default access)',
    '  ],',
    '  "settings": {',
    '    "defaultAccess": "readOnly",     // readWrite | readOnly (default readOnly)',
    '    "autoActivate": true             // open the file => apply it (default true)',
    '  }',
    '}',
    '```',
    '',
    '## Rules',
    '- Per-folder `access`: `readWrite` or `readOnly`. **Unlabeled folders default to `readOnly`** (security-first) unless `settings.defaultAccess` flips it.',
    '- Relative `path` values resolve against the manifest file\'s own directory.',
    '- `folders` must be a non-empty array; each entry is a path string or `{path, name?, access?}`.',
    '- Absolute paths from other drives/shares are allowed (Windows, UNC).',
    '',
    '## Applying changes (important)',
    '- The file is the single source of truth. After you create or edit it, tell the user to re-open it (or click its "应用此工作区" button / the tree ⟳ refresh icon, which re-applies the active manifest).',
    '- The session cwd is auto-included as an implicit readWrite root unless the manifest lists it (then its listed access wins).',
    '- Model native tools are still sandboxed to the session cwd; folders outside it (e.g. Desktop) are reachable by the sidebar, not by the model\'s tools.',
    '',
    '## Common asks',
    '- "把这些目录建成工作区（目录1/2 读写、目录3 只读）" → create a `.dsh-workspace` with those `folders` and the right `access`.',
    '- "把权限改成读写 / 加一个目录 / 删一个目录" → edit the matching `folders` entry, keep the rest intact, then ask the user to re-apply.',
  ].join('\n'),
}
