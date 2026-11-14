---
'@tanstack/react-start-client': patch
'@tanstack/start-client-core': patch
'@tanstack/solid-start-client': patch
---

`<Hydrate>` boundaries keep working when React cleans up and sets up their effects again on the same instance. React 19.3 does this in development for Strict Mode hydration (Start's default client entry uses `<StrictMode>`), so `interaction()` and `dynamic` boundaries never hydrated on interaction in dev, and a `prefetch` function received an aborted signal and never ran again. Showing an `<Activity>` again after hiding it now behaves the same way. A boundary registers its gate when its effects mount and releases it when they unmount, and keeps the snapshot of its server HTML until the boundary itself unmounts. Each mount starts its own `prefetch` run, and a run aborted before it starts never calls the `prefetch` function.
