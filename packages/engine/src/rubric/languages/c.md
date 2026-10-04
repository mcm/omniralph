# C

## Security (`security`)

- Flag `gets()` — no bounds checking, always a buffer overflow; replace with `fgets()`
- Flag `strcpy()` / `strcat()` — use `strncpy()` / `strncat()` with explicit size, or `strlcpy()` / `strlcat()`
- Flag `sprintf()` — use `snprintf()` with explicit buffer size
- Flag `scanf("%s", buf)` without a width specifier — unbounded read
- Flag `strlen()` result used as a signed integer — potential truncation on 64-bit
- Flag user-controlled data used as a format string (`printf(user_input)`) — format string attack
- Flag integer arithmetic used as array index without bounds check
- Flag signed integer overflow — undefined behavior in C

## Async / concurrency (`concurrency`)

- Flag shared global or `static` variables accessed from multiple threads without a mutex or `_Atomic`
- Flag `pthread_mutex_t` / `sem_t` not initialized before use
- Flag signal handlers that call non-async-signal-safe functions (`malloc`, `printf`, etc.)
- Flag `volatile` used as a substitute for proper synchronization — it is not sufficient
- Flag lock acquisition order inconsistency across call sites — deadlock risk

## Resource management (`resources`)

- Flag every `malloc` / `calloc` / `realloc` path — verify a matching `free` exists on all exit paths
- Flag `fopen` without a matching `fclose` on all paths including error paths
- Flag `dup` / `socket` / `open` file descriptors not closed on all paths
- Flag stack-allocated VLAs (variable-length arrays) of unbounded size — stack overflow risk
- Flag `realloc` return value assigned directly to the source pointer — leaks on failure

## Exception handling (`error-handling`)

- Flag ignored return values from `malloc`, `fopen`, `read`, `write`, `close` — all can fail
- Flag `errno` checked after a function that doesn't set it, or not checked immediately after one that does
- Flag `perror` / `strerror` as the sole error handling in library code — propagate errors to callers
- Flag functions that return `-1` on error without documenting which `errno` values are possible
- Flag `assert()` used for runtime error handling — disabled by `NDEBUG` in production builds

## Performance (`performance`)

- Flag `strlen()` called repeatedly on the same string in a loop — cache the result
- Flag unnecessary copies of large structs passed by value — pass by pointer
- Flag `memcpy` / `memset` on overlapping regions — use `memmove` for overlapping
- Flag repeated heap allocations in a tight loop — consider a pool or stack allocation
- Flag `volatile` on variables not accessed by hardware or signal handlers — prevents optimization
