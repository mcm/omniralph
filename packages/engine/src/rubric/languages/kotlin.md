# Kotlin

## Security (`security`)

- Flag Room / SQLite queries built with string concatenation — require parameterized queries
- Flag `WebView.loadUrl()` with user-controlled input without validation
- Flag credentials stored in `SharedPreferences` — require `EncryptedSharedPreferences` or Keychain

## Async / concurrency (`concurrency`)

- Flag `GlobalScope.launch` / `GlobalScope.async` in production code — use a structured scope
- Flag `runBlocking` outside of tests or top-level main functions
- Flag `launch` / `async` without a `CoroutineExceptionHandler` or `supervisorScope` where individual failures should not cancel siblings
- Flag `Dispatchers.Main` used for CPU-bound work — use `Dispatchers.Default`
- Flag coroutine cancellation not respected — long loops should check `isActive` or call `yield()`

## Resource management (`resources`)

- Flag `Closeable` / `AutoCloseable` not wrapped in `.use { }` (Kotlin's try-with-resources equivalent)
- Flag `OkHttpClient` / `Retrofit` instantiated per-request — share a singleton
- Flag `BroadcastReceiver` registered without a corresponding `unregisterReceiver` — memory / battery leak
- Flag coroutines that hold a resource across a `suspend` point without structured cleanup in `finally`

## Exception handling (`error-handling`)

- Flag `runCatching { }.getOrNull()` used broadly — silently swallows all exceptions
- Flag `catch (e: Exception)` in coroutines without re-throwing `CancellationException` — breaks structured concurrency
- Flag empty `catch` blocks
- Flag `throw RuntimeException(e)` without a descriptive message

## Performance (`performance`)

- Flag `buildString` / `StringBuilder` not used for multi-step string construction in loops
- Flag `List` used for frequent `contains` checks — prefer `Set`
- Flag `flow.collect {}` re-subscribing on every recomposition in Jetpack Compose — use `collectAsStateWithLifecycle`
- Flag `Dispatchers.IO` used for CPU-bound work — use `Dispatchers.Default`
- Flag `suspend` functions calling non-suspend blocking APIs directly — wrap with `withContext(Dispatchers.IO)`
