/**
 * An error's message as a sentence, for a tool's answer to the model: the
 * message itself, ending in a full stop, or a sentence saying there was none.
 */
export function asSentence(error: unknown): string {
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim()
  if (!message) return 'No reason was given.'
  return /[.!?]$/.test(message) ? message : `${message}.`
}
