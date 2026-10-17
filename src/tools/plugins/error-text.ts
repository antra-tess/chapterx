/**
 * A failure's reason as a sentence, for a tool's answer to the model: an
 * Error's message, a thrown string, number or boolean, or an object's string
 * `message`, ending in a full stop; or a sentence saying there was none.
 */
export function asSentence(error: unknown): string {
  const message = reasonOf(error).trim()
  if (!message) return 'No reason was given.'
  return /[.!?]$/.test(message) ? message : `${message}.`
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error)
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : ''
}
