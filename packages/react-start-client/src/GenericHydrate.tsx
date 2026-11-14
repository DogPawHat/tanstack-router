'use client'

import * as React from 'react'

import { reactUse, useHydrated, useLayoutEffect } from '@tanstack/react-router'
import { isServer } from '@tanstack/router-core/isServer'
import {
  hydrateIdAttribute,
  hydrateWhenAttribute,
} from '@tanstack/start-client-core/hydration/constants'
import {
  createResolvedGate,
  getFallbackHtml,
  getOrCreateGate,
  onGateResolve,
  releaseGate,
  retainGate,
  runHydrationStrategyCleanup,
  saveFallbackHtml,
  waitForHydrationPrefetchStrategy,
} from '@tanstack/start-client-core/hydration/runtime'
import { listenForDelegatedHydrationIntent } from '@tanstack/start-client-core/hydration'
import type {
  HydrationRuntimeContext,
  HydrationStrategy,
  HydrationWhen,
} from '@tanstack/start-client-core/hydration'
import type { HydrationGateRecord } from '@tanstack/start-client-core/hydration/runtime'
import type { HydrateProps, InternalHydrateProps } from './Hydrate'

type Gate = HydrationGateRecord & { promise: Promise<void> }
type PrefetchController = {
  signal: AbortSignal
  hydrationRequested: boolean
  hydrationListeners: Set<() => void>
  hydrationResolvePending: boolean
  promise: Promise<void>
}

const dynamicType = 'dynamic'
const dynamicHydrateStrategy = {
  _t: dynamicType,
  _d: () => true,
} satisfies HydrationStrategy<typeof dynamicType, false>

function shouldDeferHydration(strategy: HydrationStrategy) {
  return strategy._d ? strategy._d() : strategy._t !== 'load'
}

function useLatest<T>(value: T) {
  const ref = React.useRef(value)
  ref.current = value
  return ref
}

function useHydrationGate(props: InternalHydrateProps) {
  const hydrated = useHydrated()
  const reactId = React.useId()
  const id = props.h ? `${props.h}${reactId}` : reactId
  const when = props.when
  const isDynamicHydrate = typeof when === 'function'
  const dynamicHydrateStrategyRef = React.useRef<HydrationStrategy | undefined>(
    undefined,
  )
  if (isDynamicHydrate) {
    dynamicHydrateStrategyRef.current ??=
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (isServer ?? typeof window === 'undefined')
        ? dynamicHydrateStrategy
        : when()
  }
  const hydrateStrategy = isDynamicHydrate
    ? dynamicHydrateStrategyRef.current!
    : when
  const markerHydrateType: HydrationWhen = isDynamicHydrate
    ? dynamicType
    : hydrateStrategy._t!
  const [prefetchError, setPrefetchError] = React.useState<unknown>()
  const latestRef = useLatest({
    prefetch: props.prefetch,
    preload: props.p,
  })
  const gateRef = React.useRef<HydrationGateRecord | undefined>(undefined)
  const markerElementRef = React.useRef<HTMLDivElement | null>(null)
  const shouldPreserveServerHTMLRef = React.useRef<boolean | undefined>(
    undefined,
  )
  const shouldDeferInitialHydrationRef = React.useRef<boolean | undefined>(
    undefined,
  )
  const didPrefetchRef = React.useRef(false)
  const prefetchControllerRef = React.useRef<PrefetchController | undefined>(
    undefined,
  )

  shouldPreserveServerHTMLRef.current ??=
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (isServer ?? typeof window === 'undefined') || !hydrated
  shouldDeferInitialHydrationRef.current ??=
    !hydrated && shouldDeferHydration(hydrateStrategy)

  if (!gateRef.current) {
    gateRef.current =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (isServer ?? typeof window === 'undefined')
        ? createResolvedGate(id, hydrateStrategy._t!)
        : getOrCreateGate(id, hydrateStrategy._t!)
  }

  gateRef.current.when = hydrateStrategy._t!

  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    !(isServer ?? typeof window === 'undefined') &&
    hydrateStrategy._t !== 'never' &&
    (!shouldDeferInitialHydrationRef.current ||
      !shouldDeferHydration(hydrateStrategy))
  ) {
    gateRef.current.resolve()
  }

  const markerRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      markerElementRef.current = element
      if (
        element &&
        hydrateStrategy._t === 'never' &&
        !shouldPreserveServerHTMLRef.current
      ) {
        element.replaceChildren()
      }
    },
    [hydrateStrategy._t],
  )

  // Strict Mode and Activity can clean up and set up these effects again on
  // the same instance, so each setup re-establishes what its cleanup removes.
  useLayoutEffect(() => {
    const gate = gateRef.current!
    retainGate(gate)
    return () => releaseGate(gate)
  }, [])

  // Passive, unlike the gate: an ancestor Suspense hiding this boundary only
  // disconnects layout effects, and the server HTML must survive that.
  React.useEffect(() => {
    const element = markerElementRef.current
    return element ? saveFallbackHtml(gateRef.current!.id, element) : undefined
  }, [])

  React.useEffect(() => {
    const prefetchInput = latestRef.current.prefetch
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (isServer ?? typeof window === 'undefined') ||
      !prefetchInput
    ) {
      return
    }

    const preload = () => latestRef.current.preload?.() ?? Promise.resolve()

    if (typeof prefetchInput !== 'function') {
      if (!latestRef.current.preload) return

      return runHydrationStrategyCleanup(
        prefetchInput._s?.({
          element: markerElementRef.current,
          prefetch: () => {
            if (didPrefetchRef.current) return
            didPrefetchRef.current = true
            void preload()
          },
        }),
      )
    }

    const abortController = new AbortController()
    const signal = abortController.signal
    const onHydrate = (listener: () => void) => {
      if (controller.hydrationRequested) {
        listener()
        return () => {}
      }

      controller.hydrationListeners.add(listener)
      return () => {
        controller.hydrationListeners.delete(listener)
      }
    }

    const controller: PrefetchController = {
      signal,
      hydrationRequested: false,
      hydrationListeners: new Set<() => void>(),
      hydrationResolvePending: false,
      // A run cleaned up before it starts, as Strict Mode does, never calls
      // the prefetch function.
      promise: Promise.resolve().then(async () => {
        if (signal.aborted) return
        await prefetchInput({
          element: markerElementRef.current,
          signal,
          preload,
          waitFor: (strategy) =>
            waitForHydrationPrefetchStrategy(strategy, {
              element: markerElementRef.current,
              signal,
              onHydrate,
            }),
        })
      }),
    }
    prefetchControllerRef.current = controller
    controller.promise.catch((error) => {
      if (!signal.aborted) {
        setPrefetchError(error)
      }
    })

    // Aborting settles every pending `waitFor`, which removes its listener.
    return () => abortController.abort()
  }, [latestRef])

  useLayoutEffect(() => {
    const gate = gateRef.current!
    if (
      !shouldDeferInitialHydrationRef.current ||
      hydrateStrategy._t === 'never'
    ) {
      return
    }

    if (gate.resolved) {
      return
    }

    const cleanups: Array<() => void> = []
    let removeResolveListener = () => {}
    let disposed = false
    const resolveGate = gate.resolve

    const cleanup = () => {
      if (disposed) return
      disposed = true
      if (gate.resolve === requestHydration) {
        gate.resolve = resolveGate
      }
      removeResolveListener()
      cleanups.forEach((fn) => fn())
    }

    const addCleanup = (fn: void | (() => void)) => {
      if (!fn) return
      if (disposed || gate.resolved) {
        fn()
        return
      }
      cleanups.push(fn)
    }

    const requestHydration = () => {
      const controller = prefetchControllerRef.current
      if (!controller) {
        resolveGate()
        return
      }
      if (!controller.hydrationRequested) {
        controller.hydrationRequested = true
        controller.hydrationListeners.forEach((listener) => listener())
        controller.hydrationListeners.clear()
      }

      if (controller.hydrationResolvePending) return
      controller.hydrationResolvePending = true

      controller.promise.then(
        () => resolveGate(),
        (error) => {
          if (!controller.signal.aborted) {
            setPrefetchError(error)
          }
        },
      )
    }

    gate.resolve = requestHydration
    removeResolveListener = onGateResolve(gate, cleanup)

    const context: HydrationRuntimeContext = {
      element: markerElementRef.current,
      gate,
    }
    addCleanup(runHydrationStrategyCleanup(hydrateStrategy._s?.(context)))

    if (hydrateStrategy._t !== 'interaction') {
      addCleanup(
        runHydrationStrategyCleanup(
          markerElementRef.current
            ? listenForDelegatedHydrationIntent(
                markerElementRef.current,
                context,
              )
            : undefined,
        ),
      )
    }

    return cleanup
  }, [hydrateStrategy, latestRef])

  return {
    gate: gateRef.current,
    markerRef,
    markerElementRef,
    hydrateStrategy,
    markerHydrateType,
    prefetchError,
    shouldPreserveServerHTML: shouldPreserveServerHTMLRef.current,
  }
}

function HydrationGate(props: { gate: Gate; children: React.ReactNode }) {
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    isServer ??
    typeof window === 'undefined'
  ) {
    return props.children as React.JSX.Element
  }

  if (props.gate.resolved) {
    return props.children as React.JSX.Element
  }

  if (!reactUse) {
    throw props.gate.promise
  }

  reactUse(props.gate.promise)

  return props.children as React.JSX.Element
}

function HydratedBoundary(props: {
  id: string
  onHydrated?: () => void
  onStrategyHydrated?: (id: string) => void
  children: React.ReactNode
}) {
  const { id, onHydrated, onStrategyHydrated } = props
  const didHydrateRef = React.useRef(false)

  React.useEffect(() => {
    if (didHydrateRef.current) return
    didHydrateRef.current = true
    onHydrated?.()
    onStrategyHydrated?.(id)
  }, [id, onHydrated, onStrategyHydrated])

  return props.children as React.JSX.Element
}

export function GenericHydrate(props: HydrateProps): React.JSX.Element {
  const internalProps = props as InternalHydrateProps
  const {
    gate,
    hydrateStrategy,
    markerHydrateType,
    markerElementRef,
    markerRef,
    prefetchError,
    shouldPreserveServerHTML,
  } = useHydrationGate(internalProps)
  if (prefetchError) throw prefetchError

  const fallback = shouldPreserveServerHTML
    ? (() => {
        const html = getFallbackHtml(gate.id)
        return html ? (
          <div
            style={{ display: 'contents' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null
      })()
    : (props.fallback ?? null)
  const markerAttributes =
    markerHydrateType === dynamicType ? undefined : hydrateStrategy._a?.()

  const hydrateType = hydrateStrategy._t!

  if (hydrateType === 'never' && !shouldPreserveServerHTML) {
    return (
      <div
        ref={markerRef}
        {...{
          [hydrateIdAttribute]: gate.id,
          [hydrateWhenAttribute]: markerHydrateType,
          ...markerAttributes,
        }}
      >
        {props.fallback ?? null}
      </div>
    )
  }

  return (
    <div
      ref={markerRef}
      {...{
        [hydrateIdAttribute]: gate.id,
        [hydrateWhenAttribute]: markerHydrateType,
        ...markerAttributes,
      }}
    >
      <React.Suspense fallback={fallback}>
        <HydrationGate gate={gate}>
          <HydratedBoundary
            id={gate.id}
            onHydrated={props.onHydrated}
            onStrategyHydrated={(id) => {
              markerElementRef.current?.removeAttribute(hydrateWhenAttribute)
              hydrateStrategy._o?.(id)
            }}
          >
            {props.children}
          </HydratedBoundary>
        </HydrationGate>
      </React.Suspense>
    </div>
  )
}
