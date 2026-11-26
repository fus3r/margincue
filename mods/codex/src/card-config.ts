import type { Event } from '../../claude-code/core/index'
import { describeUser, preferredProfiles, readUser, userDepths } from '../../claude-code/hooks/onboarding'
import type { Settings } from './store'
import { sendSetting } from './store'

export function cardConfig(settings: Settings): Extract<Event, { type: 'config' }> {
  const user = readUser(settings.user)
  const date = new Date()
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return {
    type: 'config', enabled: settings.mode !== 'off', mode: settings.mode ?? 'auto', language: 'en', sheet: true,
    read: settings.read === 'key' ? 'key' : 'auto', send: sendSetting(settings),
    sketch: settings.sketch !== false, refs: settings.refs !== false, today, profile: 'general',
    streaming: false, eagerPlan: false, depths: userDepths(user),
    ...(user && { user: describeUser(user), prefer: preferredProfiles(user) }),
  }
}
