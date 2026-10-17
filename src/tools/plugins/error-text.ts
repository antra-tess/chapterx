/**
 * An error's message as a sentence, for a tool's answer to the model: the
 * message itself, ending in a full stop.
 */
export function asSentence(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  return /[.!?]$/.test(message) ? message : `${message}.`
}
