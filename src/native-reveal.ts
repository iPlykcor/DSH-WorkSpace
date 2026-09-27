/**
 * Handing one operation-space path to the desktop's file manager.
 *
 * WHY THIS PLUGIN DOES IT ITSELF. DSH's own open-in-app control reaches the
 * desktop through the Session Remote, but its directory entries are bound to
 * the session cwd, and its Windows directory launch goes through
 * `openNativePath` into `explorer.exe "file:///…"` — the form `dsh-host-open-in-app`
 * itself documents as "does not reliably raise a window". An operation space
 * exists precisely for folders OUTSIDE the session cwd, so the folder-open
 * affordance lives here: fenced to the active space by its caller, and spawned
 * WITHOUT a shell, so a path is never assembled into a command string.
 *
 * EXPLORER'S EXIT CODE IS A HANDOFF, NOT A RESULT. explorer.exe exits 1 after
 * passing the request to the already-running desktop process, so exit 1 counts
 * as accepted — the same reading `dsh-native-command` documents. A process that
 * outlives the grace period is the desktop shell itself taking ownership, so a
 * timeout is a success too; treating it as a failure would hang this route on a
 * host where no Explorer process is running yet.
 */
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/**
 * How long a launch may take before the child is assumed to have become the
 * desktop shell. Explorer's ordinary handoff returns in milliseconds; this is
 * only the boundary between "handed off" and "is now the shell".
 */
const HANDOFF_GRACE_MS = 2_000

/** One launcher invocation: a program plus its argv (never a command line). */
export interface RevealInvocation {
  command: string
  args: readonly string[]
}

/**
 * Whether this host has a desktop file manager this plugin can drive.
 * @param platform - the host platform (injectable for tests).
 * @returns true on the three platforms with a known file manager.
 */
export function canRevealNative(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux'
}

/**
 * Build the shell-free invocation that shows one path in the desktop file
 * manager: a directory opens, a file is revealed with its parent selected
 * where the platform supports selection.
 *
 * WINDOWS TAKES THE PLAIN HOST PATH, in ONE argv element, and nothing else.
 * Each step of this was measured by launching Explorer and then asking the
 * window WHAT it had selected — a hidden or desktop-titled window still reports
 * itself through COM, so "a window exists" would have proven nothing:
 *
 * - the plain path selects correctly, including for Chinese paths;
 * - a percent-encoded file URL (`file:///…`) selects correctly for an ASCII
 *   path and sends Explorer to the DESKTOP for a Chinese one — the same form
 *   DSH's own `openNativePath` uses, which is why its reveal misbehaves;
 * - wrapping the path in quotes opens Documents with nothing selected, for
 *   every path shape tried;
 * - a path containing a comma cannot be selected at all: `/select,` splits its
 *   argument on commas and an unresolvable target lands Explorer on the
 *   desktop. Such a file therefore opens its containing DIRECTORY instead —
 *   the closest honest thing a user can act on.
 * @param target - canonical absolute path (already realpath'd by the caller).
 * @param isDir - whether the target is a directory.
 * @param platform - the host platform (injectable for tests).
 * @returns the invocation, or undefined on a platform with no known file manager.
 */
export function revealInvocation(
  target: string,
  isDir: boolean,
  platform: NodeJS.Platform = process.platform,
): RevealInvocation | undefined {
  if (platform === 'win32') {
    if (isDir) return { command: 'explorer.exe', args: [target] }
    if (target.includes(',')) return { command: 'explorer.exe', args: [dirname(target)] }
    return { command: 'explorer.exe', args: [`/select,${target}`] }
  }
  if (platform === 'darwin') {
    // `open -R` is Finder's reveal-and-select; a directory opens as itself.
    return { command: 'open', args: isDir ? [target] : ['-R', target] }
  }
  if (platform === 'linux') {
    // xdg-open has no selection verb, so a file reveals its parent directory.
    return { command: 'xdg-open', args: [isDir ? target : dirname(target)] }
  }
  return undefined
}

/**
 * Run one invocation and resolve once the desktop has taken the request.
 *
 * The child never inherits this process's stdio (its output is meaningless and
 * a piped child could stall the launch), and it is unreferenced once settled so
 * an Explorer that became the shell cannot keep the host process alive.
 * @param invocation - program plus argv from {@link revealInvocation}.
 * @returns resolves on a handoff (exit 0, exit 1, or the grace timeout).
 * @throws Error when the program cannot be started or exits with another code.
 */
export async function revealNative(invocation: RevealInvocation): Promise<void> {
  await new Promise<void>((resolveHandoff, rejectFailure) => {
    let settled = false
    const child = spawn(invocation.command, [...invocation.args], {
      stdio: 'ignore',
      // Detached: the launched window outlives this request, and the host must
      // not treat it as a child it owns.
      detached: true,
      windowsHide: false,
    })
    const settle = (failure?: Error): void => {
      if (settled) return
      settled = true
      child.removeAllListeners()
      // A timeout leaves a live child (the shell itself) behind on purpose.
      child.unref()
      if (failure === undefined) resolveHandoff()
      else rejectFailure(failure)
    }
    // Deliberately NOT cleared on settle: the callback turns into a no-op
    // instead, which keeps this a `const` and lets `unref` stop the grace period
    // from holding the host process open for up to two seconds after a request
    // that already answered.
    setTimeout(() => { settle() }, HANDOFF_GRACE_MS).unref()
    child.once('error', (error: Error) => {
      settle(new Error(`cannot start ${invocation.command}: ${error.message}`))
    })
    child.once('exit', (code) => {
      // 1 is Explorer's delegated handoff; 0 is an ordinary success.
      if (code === 0 || code === 1) settle()
      else settle(new Error(`${invocation.command} exited with code ${String(code)}`))
    })
  })
}
