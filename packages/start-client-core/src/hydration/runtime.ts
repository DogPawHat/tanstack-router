import { hydrateIdAttribute, hydrateWhenAttribute } from './constants'
import type {
  HydrationPrefetchStrategy,
  HydrationPrefetchWaitReason,
  HydrationRuntimeGate,
  HydrationWhen,
} from './types'

const hydrateIdSelector = `[${hydrateIdAttribute}]`

export type HydrationGateRecord = HydrationRuntimeGate & {
  id: string
  when: HydrationWhen
  promise: Promise<void>
  consumers: number
  resolveListeners: Set<() => void>
}

const gateRegistry = /* @__PURE__ */ new Map<string, HydrationGateRecord>()
const resolvedGateIds = /* @__PURE__ */ new Set<string>()
const fallbackHtmlByGateId = /* @__PURE__ */ new Map<string, string>()

export function createResolvedGate(
  id: string,
  when: HydrationWhen,
): HydrationGateRecord {
  return {
    id,
    when,
    promise: Promise.resolve(),
    resolve: () => {},
    resolved: true,
    consumers: 0,
    resolveListeners: new Set<() => void>(),
  }
}

/**
 * Returns the registered gate for `id`, or a new unregistered gate, without
 * side effects so it can run during render. Callers register the gate with
 * `retainGate` once mounted and pair that with `releaseGate`.
 */
export function getOrCreateGate(
  id: string,
  when: HydrationWhen,
): HydrationGateRecord {
  const existing = gateRegistry.get(id)
  if (existing?.when === when) {
    return existing
  }

  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })

  const gate: HydrationGateRecord = {
    id,
    promise,
    resolved: false,
    consumers: 0,
    when,
    resolveListeners: new Set(),
    resolve: () => {
      if (gate.resolved) return
      gate.resolved = true
      resolvePromise()
      gate.resolveListeners.forEach((listener) => listener())
      gate.resolveListeners.clear()
    },
  }

  return gate
}

export function retainGate(gate: HydrationGateRecord) {
  gate.consumers++
  gateRegistry.set(gate.id, gate)
  // Intent recorded while no gate was registered for this id opens it now.
  if (resolvedGateIds.delete(gate.id) && gate.when !== 'never') {
    gate.resolve()
  }
}

export function releaseGate(gate: HydrationGateRecord) {
  resolvedGateIds.delete(gate.id)
  gate.consumers--
  if (gate.consumers > 0) return
  if (gateRegistry.get(gate.id) === gate) {
    gateRegistry.delete(gate.id)
    gate.resolveListeners.clear()
  }
}

export function onGateResolve(gate: HydrationGateRecord, listener: () => void) {
  if (gate.resolved) {
    listener()
    return () => {}
  }

  gate.resolveListeners.add(listener)
  return () => {
    gate.resolveListeners.delete(listener)
  }
}

export function runHydrationStrategyCleanup(cleanup: void | (() => void)) {
  if (typeof cleanup === 'function') return cleanup
  return undefined
}

export function waitForHydrationPrefetchStrategy(
  strategy: HydrationPrefetchStrategy,
  options: {
    element: Element | null
    signal: AbortSignal
    onHydrate: (listener: () => void) => () => void
  },
): Promise<HydrationPrefetchWaitReason> {
  if (options.signal.aborted) {
    return Promise.resolve('abort')
  }

  return new Promise((resolve) => {
    let disposed = false
    // The strategy may finish synchronously before returning its cleanup.
    let cleanupStrategy: void | (() => void) = undefined
    let cleanupHydrate = () => {}

    const finish = (reason: HydrationPrefetchWaitReason) => {
      if (disposed) {
        return
      }
      disposed = true
      options.signal.removeEventListener('abort', onAbort)
      cleanupHydrate()
      runHydrationStrategyCleanup(cleanupStrategy)?.()
      resolve(reason)
    }

    const onAbort = () => finish('abort')

    options.signal.addEventListener('abort', onAbort, { once: true })
    cleanupHydrate = options.onHydrate(() => finish('hydrate'))
    cleanupStrategy = strategy._s?.({
      element: options.element,
      prefetch: () => finish('prefetch'),
    })
    // A synchronous finish must immediately run the cleanup just returned.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (disposed) {
      runHydrationStrategyCleanup(cleanupStrategy)?.()
    }
  })
}

export function getMarkerGate(marker: Element) {
  const id = marker.getAttribute(hydrateIdAttribute)
  return id ? gateRegistry.get(id) : undefined
}

export function resolveHydrationMarker(marker: Element) {
  const id = marker.getAttribute(hydrateIdAttribute)
  const when = marker.getAttribute(hydrateWhenAttribute)
  if (!id || !when || when === 'never') {
    return
  }

  const gate = gateRegistry.get(id)
  if (gate) {
    if (gate.when !== 'never') gate.resolve()
    return
  }

  resolvedGateIds.add(id)
}

export function clearResolvedGateIdsInMarker(marker: Element) {
  const ownId = marker.getAttribute(hydrateIdAttribute)
  if (ownId) {
    resolvedGateIds.delete(ownId)
  }

  marker.querySelectorAll(hydrateIdSelector).forEach((childMarker) => {
    const childId = childMarker.getAttribute(hydrateIdAttribute)
    if (childId) {
      resolvedGateIds.delete(childId)
    }
  })
}

/**
 * Snapshots the boundary's server HTML once per id and returns a function that
 * forgets it. The snapshot must outlive layout-only disconnects (an ancestor
 * Suspense hiding the boundary), so callers forget it on unmount, not when
 * the gate is released.
 */
export function saveFallbackHtml(id: string, element: Element) {
  if (!fallbackHtmlByGateId.has(id)) {
    fallbackHtmlByGateId.set(id, element.innerHTML)
  }
  return () => {
    fallbackHtmlByGateId.delete(id)
  }
}

export function getFallbackHtml(id: string) {
  return fallbackHtmlByGateId.get(id)
}
