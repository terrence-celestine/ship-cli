import { execFile } from "child_process"

export type NotificationSound = "Glass" | "Basso" | "Pop"

export interface NotifyOptions {
  title: string
  message: string
  sound: NotificationSound
  /**
   * Where to report a failed notification. Deliberately has no default: this
   * module can't know how its host draws to the terminal, and writing straight
   * to stdout would splice into the caller's status line.
   */
  onError?: (message: string) => void
}

/**
 * Escape for embedding in an AppleScript string literal.
 *
 * Order is load-bearing. Backslashes must be doubled BEFORE quotes are escaped,
 * or the backslash this adds to `\"` gets doubled in turn and breaks the
 * literal. Newlines must be converted AFTER, so their backslash isn't doubled.
 */
export const escapeAppleScript = (value: string): string =>
  value
    // Control characters with no AppleScript escape. \n and \r survive for the
    // last step; a stray \x1b would otherwise mean raw ANSI in the banner.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, "\\n")

/**
 * Assemble the AppleScript. Separate from `notify` so it can be tested without
 * spawning anything — the security property is a property of this string, not
 * of the escaper alone.
 */
export const buildNotificationScript = ({ title, message, sound }: Omit<NotifyOptions, "onError">): string =>
  `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "${sound}"`

export function notify({ title, message, sound, onError }: NotifyOptions): void {
  const script = buildNotificationScript({ title, message, sound })

  // execFile, not exec: arguments go straight to the process with no /bin/sh in
  // between, so shell metacharacters in a project name can't be interpreted.
  execFile("osascript", ["-e", script], (err) => {
    if (err) onError?.(err.message)
  })
}
