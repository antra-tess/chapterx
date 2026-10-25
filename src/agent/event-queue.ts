import { Event } from '../types.js'

export class EventQueue {
  private queue: Event[] = []

  push(event: Event): void {
    this.queue.push(event)
  }

  prepend(events: Event[]): void {
    this.queue.unshift(...events)
  }

  pollBatch(): Event[] {
    if (this.queue.length === 0) {
      return []
    }

    const batch: Event[] = []
    const firstEvent = this.queue.shift()

    if (!firstEvent) {
      return []
    }

    batch.push(firstEvent)

    const isDiscordEvent = this.isDiscordEvent(firstEvent)

    while (this.queue.length > 0) {
      const nextEvent = this.queue[0]

      if (!nextEvent) {
        break
      }

      if (
        nextEvent.channelId !== firstEvent.channelId ||
        this.isDiscordEvent(nextEvent) !== isDiscordEvent
      ) {
        break
      }

      batch.push(this.queue.shift()!)
    }

    return batch
  }

  isEmpty(): boolean {
    return this.queue.length === 0
  }

  size(): number {
    return this.queue.length
  }

  clear(): void {
    this.queue = []
  }

  private isDiscordEvent(event: Event): boolean {
    return ['message', 'reaction', 'edit', 'delete'].includes(event.type)
  }
}
