/**
 * Timer Module
 *
 * Exports timer scheduler for wake-up timers.
 */

export {
  TimerScheduler,
  getTimerScheduler,
  createTimerScheduler,
} from './scheduler.js'

// Type-only export for interfaces (erased at runtime)
export type { ScheduledTimer } from './scheduler.js'
