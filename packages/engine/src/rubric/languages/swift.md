# Swift

## Security (`security`)

- Flag credentials stored in `UserDefaults` — require Keychain
- Flag `URLSession` requests over plain HTTP in production
- Flag `WKWebView` loading arbitrary user-supplied URLs without validation

## Async / concurrency (`concurrency`)

- Flag `DispatchQueue.main.sync` called from the main thread — deadlock
- Flag `@escaping` closures capturing `self` strongly in reference cycles — use `[weak self]`
- Flag mixing `async/await` and `DispatchQueue` for the same operation without clear reasoning
- Flag `Task { }` (unstructured) where a structured `async let` or `TaskGroup` would maintain structure
- Flag data races — shared mutable state accessed from multiple tasks without an actor

## Resource management (`resources`)

- Flag `URLSessionDataTask` started with no cancellation handle stored — cannot be cancelled if the view disappears
- Flag `NotificationCenter` observers added without a corresponding `removeObserver` — memory leak
- Flag `CLLocationManager` / `AVCaptureSession` not stopped when the owning view controller is dismissed

## Exception handling (`error-handling`)

- Flag `try!` outside of guaranteed-safe contexts (test fixtures, constants) — crashes on failure
- Flag `try?` discarding errors where the failure mode matters to the caller
- Flag error types conforming to `Error` with no associated values or message — makes debugging hard
- Flag throwing functions calling `fatalError()` as a fallback — choose one error strategy

## Performance (`performance`)

- Flag `UIImage(named:)` called repeatedly for the same asset without caching
- Flag synchronous network calls on the main thread
- Flag `Array` used for frequent membership tests — prefer `Set`
- Flag `String` interpolation inside tight loops where a pre-built string would avoid allocations
