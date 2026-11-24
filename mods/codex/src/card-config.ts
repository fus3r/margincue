import type { Event } from '../../claude-code/core/index'
import { depthFor, describeUser, preferredProfiles } from '../../claude-code/hooks/onboarding'
import type { Settings } from './store'

export function cardConfig(settings: Settings): Extract<Event, { type: 'config' }> {
  const user = settings.user
  const depths = Object.fromEntries(Object.entries(user?.levels ?? {}).map(([profile, level]) => [profile, depthFor(level)]))
  const date = new Date()
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return {
    type: 'config', enabled: settings.mode !== 'off', mode: settings.mode ?? 'auto', language: 'en', sheet: true,
    sketch: settings.sketch !== false, refs: settings.refs !== false, today, profile: 'general',
    streaming: false, eagerPlan: false, depths,
    ...(user && { user: describeUser(user), prefer: preferredProfiles(user) }),
  }
}
