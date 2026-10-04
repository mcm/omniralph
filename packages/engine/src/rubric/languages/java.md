# Java

## Security (`security`)

- Flag JPQL / HQL or native SQL string concatenation — require named parameters or `CriteriaBuilder`
- Flag `@RequestMapping` without explicit HTTP method restriction on state-changing endpoints
- Flag user-controlled input passed to `Runtime.exec()` or `ProcessBuilder` without validation
- Flag `ObjectInputStream.readObject()` on untrusted data — unsafe deserialization
- Flag hardcoded JDBC URLs or credentials — require environment variables or a vault

## Async / concurrency (`concurrency`)

- Flag `ExecutorService.submit()` return value ignored — exceptions are swallowed
- Flag `Thread.sleep()` used as a synchronization mechanism — use `CountDownLatch`, `CompletableFuture`, or `await()`
- Flag `CompletableFuture` chains with no `.exceptionally()` or `.handle()` terminal handler
- Flag `InterruptedException` caught without calling `Thread.currentThread().interrupt()`
- Flag `synchronized` on a non-final field — the lock object can be replaced
- Flag `HashMap` used in multi-threaded context — use `ConcurrentHashMap`

## Resource management (`resources`)

- Flag `InputStream`, `OutputStream`, `Connection`, `ResultSet`, `PreparedStatement` not wrapped in try-with-resources
- Flag manual `finally { resource.close() }` — replace with try-with-resources
- Flag `HttpURLConnection` not disconnected after use
- Flag JDBC `Connection` obtained from a pool and not returned (missing `close()`) on all paths
- Flag `static` `HttpClient` or `Connection` fields shared across threads without connection pool management

## Exception handling (`error-handling`)

- Flag empty `catch` blocks — `catch (Exception e) {}`
- Flag `InterruptedException` caught without `Thread.currentThread().interrupt()` — breaks cooperative cancellation
- Flag checked exceptions swallowed in a `catch` and not re-thrown or logged with context
- Flag `throw new RuntimeException(e)` without a descriptive message — loses context
- Flag `printStackTrace()` as the sole error handling — use a proper logger

## Performance (`performance`)

- Flag `String` concatenation in loops — use `StringBuilder`
- Flag `List.contains()` / `Map.get()` in a loop on large collections — review data structure choice
- Flag N+1 JPA / Hibernate queries — use `JOIN FETCH` or `@BatchSize`
- Flag `new ObjectMapper()` / `new Gson()` instantiated per-request — share a singleton
- Flag `ResultSet` fully iterated when only the first result is needed — use `LIMIT 1` in the query
