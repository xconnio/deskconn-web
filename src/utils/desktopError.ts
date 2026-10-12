import { ApplicationError } from 'xconn'

export const DESKTOP_OFFLINE_MESSAGE = 'Desktop is offline.'
export const BACKEND_UPDATE_MESSAGE = 'This feature needs a newer version of the desktop backend. Please update it.'

function errorUri(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof Error) {
    return (error.message || '').toLowerCase()
  }
  return ''
}

function errorText(error: unknown): string {
  if (error instanceof ApplicationError) {
    const arg = error.args?.[0]
    if (typeof arg === 'string' && arg) return arg
  }
  if (error instanceof ApplicationError || error instanceof Error) {
    return error.message || ''
  }
  return ''
}

export function isNoSuchProcedureException(error: unknown): boolean {
  // deskconnd's bridge wraps a missing procedure as operation_failed with the original
  // error as its text.
  return [errorUri(error), errorText(error)].some((s) => s.toLowerCase().includes('wamp.error.no_such_procedure'))
}

// send() on a RTCDataChannel throws "RTCDataChannel.readyState is not 'open'"
// once the connection has dropped.
export function isDataChannelClosedError(error: unknown): boolean {
  const message = errorUri(error)
  return message.includes('rtcdatachannel') && message.includes("readystate is not 'open'")
}

// errEditConflict — file changed on disk since it was read.
export function isEditConflictError(error: unknown): boolean {
  return errorText(error).toLowerCase().includes('could not be applied cleanly')
}

// A missing procedure means the connected backend is just too old to support
// this call, not that the desktop is unreachable — don't conflate the two.
export function isDesktopOfflineError(error: unknown): boolean {
  return isDataChannelClosedError(error)
}

export function formatDesktopError(error: unknown, fallback = DESKTOP_OFFLINE_MESSAGE): string {
  if (isNoSuchProcedureException(error)) {
    return BACKEND_UPDATE_MESSAGE
  }
  if (isDesktopOfflineError(error)) {
    return DESKTOP_OFFLINE_MESSAGE
  }
  const text = errorText(error)
  if (!text) console.error('formatDesktopError: falling back to default message for unrecognized error:', error)
  return text || fallback
}
