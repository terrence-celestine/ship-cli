import { exec } from "child_process"

export function notify(title: string, message: string, sound: "Glass" | "Basso"): void {
  // Escape double quotes in user input so AppleScript doesn't break
  const safeTitle = title.replace(/"/g, '\\"')
  const safeMessage = message.replace(/"/g, '\\"')

  const script = `display notification "${safeMessage}" with title "${safeTitle}" sound name "${sound}"`

  exec(`osascript -e '${script}'`, (err) => {
    if (err) {
      console.error("Notification failed:", err.message)
    }
  })
}