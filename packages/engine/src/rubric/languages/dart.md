# Dart / Flutter

## Security (`security`)

- Flag API keys or secrets hardcoded in Dart source or `pubspec.yaml` — use `--dart-define` or a secrets manager
- Flag `http` package used without certificate validation disabled intentionally
- Flag `SharedPreferences` used to store sensitive data — use `flutter_secure_storage`
- Flag user-controlled input used in `dart:io` file path operations without sanitization
- Flag `WebView` loading arbitrary user-supplied URLs without validation
- Flag deep link / URL scheme handlers that don't validate the incoming URL before acting on it

## Async / concurrency (`concurrency`)

- Flag `BuildContext` used after an `await` without checking `if (!mounted) return` — context may be invalid
- Flag `Future` returned but not `await`-ed and without `.catchError()` or `unawaited()` — floating future
- Flag `Isolate.spawn` without a clear message-passing protocol
- Flag heavy computation on the main isolate — offload with `compute()` or `Isolate.run()`
- Flag `StreamController` not closed when the owning widget is disposed — memory leak
- Flag `async*` / `yield*` generators with no error handling on the stream consumer side

## Resource management (`resources`)

- Flag `StreamController` not closed in `dispose()`
- Flag `AnimationController` not disposed in `dispose()`
- Flag `TextEditingController` / `FocusNode` / `ScrollController` not disposed in `dispose()`
- Flag `Timer` not cancelled in `dispose()`
- Flag listeners added to `ChangeNotifier` / `ValueNotifier` without a corresponding `removeListener`

## Exception handling (`error-handling`)

- Flag empty `catch` blocks — swallowed errors
- Flag `catchError` with no handler body — silent failure
- Flag `Future.error` not surfaced to the UI — show an error state
- Flag `FlutterError.onError` overridden without calling the original handler

## Performance (`performance`)

- Flag `setState` called for changes that only affect a small subtree — use `ValueNotifier` / `provider` / `Riverpod` to scope rebuilds
- Flag expensive computation inside `build()` — move to `initState`, a controller, or a `FutureBuilder`
- Flag `ListView` without `ListView.builder` for long or infinite lists — builds all children at once
- Flag missing `const` on widgets that never change — prevents unnecessary rebuilds
- Flag `Image.network` without a caching package in a list — re-downloads on every scroll
- Flag `RepaintBoundary` missing around frequently-repainted widgets (animations, counters)
