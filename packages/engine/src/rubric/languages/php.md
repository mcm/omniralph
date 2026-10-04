# PHP

## Security (`security`)

- Flag `$_GET` / `$_POST` / `$_REQUEST` used directly in SQL queries — require PDO prepared statements
- Flag `mysqli_query($conn, "SELECT ... WHERE id = " . $_GET['id'])` — SQL injection
- Flag `echo $_GET['name']` or any unescaped output — XSS; use `htmlspecialchars()` with `ENT_QUOTES`
- Flag `include` / `require` with user-controlled paths — local/remote file inclusion
- Flag `eval()` — remote code execution risk; no legitimate use in application code
- Flag `shell_exec` / `exec` / `system` / `passthru` with user-controlled input — command injection
- Flag `unserialize()` on untrusted data — arbitrary object instantiation and code execution
- Flag `move_uploaded_file` without MIME type validation and extension whitelist — file upload attack
- Flag `header("Location: " . $_GET['url'])` without validation — open redirect
- Flag missing CSRF token validation on state-changing form endpoints

## Async / concurrency (`concurrency`)

- Flag long-running synchronous operations in a request cycle — offload to a queue (Laravel Queue, RabbitMQ)
- Flag `sleep()` used inside a request handler — blocks the PHP-FPM worker
- Flag shared mutable state in `static` properties accessed across requests in long-running processes (Swoole, RoadRunner)
- Flag missing idempotency in queued jobs — jobs can be retried on failure

## Resource management (`resources`)

- Flag database connections not closed or returned to the pool (`$pdo = null` or `$conn->close()`)
- Flag `fopen` / `fwrite` without a matching `fclose` on all paths
- Flag `curl_init` without `curl_close` — leaks the curl handle
- Flag unbounded file uploads with no size or type restriction
- Flag sessions not explicitly closed (`session_write_close()`) before long operations — session locking blocks other requests

## Exception handling (`error-handling`)

- Flag empty `catch` blocks — swallowed exceptions
- Flag `catch (Exception $e) {}` without logging — silent failure
- Flag `die()` / `exit()` used for error handling in library code — use exceptions
- Flag `@` operator used to suppress errors from functions that can fail — check return values instead
- Flag `trigger_error` used in new code — prefer exceptions

## Performance (`performance`)

- Flag N+1 Eloquent / Doctrine queries — use eager loading (`with()`, `load()`, `join`)
- Flag `count($array)` called repeatedly in a loop condition — cache the result
- Flag `array_push($arr, $val)` — use `$arr[] = $val` which is faster
- Flag `in_array` on large arrays without the strict third argument — use `isset` on a flipped array for O(1) lookup
- Flag `file_get_contents` on remote URLs in a request cycle — use an HTTP client with timeout and async where possible
- Flag Eloquent `all()` without pagination — loads entire table into memory
