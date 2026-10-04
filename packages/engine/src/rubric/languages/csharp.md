# C# / .NET

## Security (`security`)

- Flag raw string interpolation in SQL queries — require parameterized queries (`SqlCommand`) or EF Core
- Flag missing `[ValidateAntiForgeryToken]` on state-changing controller actions
- Flag user-controlled data passed to `Process.Start()` or `File` APIs without validation
- Flag hardcoded connection strings — require `appsettings.json` + secrets management
- Flag `[AllowAnonymous]` on endpoints that should be protected

## Async / concurrency (`concurrency`)

- Flag `async void` methods outside of event handlers — cannot be awaited and swallow exceptions
- Flag `.Result`, `.Wait()`, or `.GetAwaiter().GetResult()` on `Task` — causes deadlocks in ASP.NET contexts
- Flag missing `ConfigureAwait(false)` in library (non-application) code
- Flag `Task.Run()` wrapping synchronous code inside ASP.NET request handlers unnecessarily
- Flag `CancellationToken` not threaded through to downstream async calls

## Resource management (`resources`)

- Flag `IDisposable` objects (`SqlConnection`, `HttpClient`, `FileStream`, etc.) not wrapped in `using` / `using var`
- Flag `HttpClient` instantiated with `new` inside a method — use `IHttpClientFactory` or a shared static instance to avoid socket exhaustion
- Flag `DbContext` registered as a singleton in DI — it must be scoped
- Flag `MemoryStream` / `MemoryCache` growing unboundedly without eviction policy

## Exception handling (`error-handling`)

- Flag `catch { }` or `catch (Exception) { }` with no logging or re-throw — silent swallow
- Flag `catch (Exception e) { throw e; }` — resets the stack trace; use `throw;` instead
- Flag catching `Exception` when a specific type (`IOException`, `HttpRequestException`) is appropriate
- Flag exception filters (`when`) used for side effects that suppress the exception
- Flag exceptions used for control flow in hot paths — use `Try*` pattern methods instead

## Performance (`performance`)

- Flag `.ToList()` / `.ToArray()` on `IQueryable` before filtering — forces all rows into memory; filter server-side first
- Flag `string` concatenation in loops — use `StringBuilder`
- Flag `Enumerable.Count()` on `IQueryable` when only an existence check is needed — use `Any()`
- Flag `await` in a loop where `Task.WhenAll()` would parallelize the work
- Flag synchronous file or network I/O in an `async` method — use the async overload
