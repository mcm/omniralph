# Go

## Security (`security`)

- Flag `database/sql` queries built with `fmt.Sprintf` — require `?` / `$N` placeholders
- Flag `os/exec` calls with user-controlled arguments without sanitization
- Flag `html/template` bypassed in favor of `text/template` for HTML output
- Flag `http.ListenAndServeTLS` with `InsecureSkipVerify: true`

## Async / concurrency (`concurrency`)

- Flag goroutines started with no clear lifetime or cancellation path — always pass `context.Context`
- Flag goroutines that write to a channel with no receiver and no `select` default — causes a leak
- Flag `time.Sleep()` used inside a goroutine as a synchronization mechanism
- Flag `sync.WaitGroup.Add()` called inside the goroutine it tracks — race condition
- Flag `sync.Mutex` copied by value — must always be used as a pointer or embedded in a struct

## Resource management (`resources`)

- Flag `http.Response.Body` not closed after reading — even on error paths (`defer resp.Body.Close()`)
- Flag `os.File` not closed — use `defer f.Close()` immediately after opening
- Flag `rows.Close()` missing after `sql.Query()` — leaks the DB connection
- Flag `context.WithCancel` / `context.WithTimeout` cancel function not called — context and resources leak

## Exception handling (`error-handling`)

- Flag errors assigned to `_` without a comment explaining why it is safe to ignore
- Flag errors not wrapped with `fmt.Errorf("...: %w", err)` — loses stack context
- Flag `panic()` used for expected runtime errors — reserve for programming errors and unrecoverable states
- Flag `recover()` used to silently swallow panics without logging

## Performance (`performance`)

- Flag `fmt.Sprintf` used for simple string concatenation — use `strings.Builder` or `+` for small cases
- Flag `append()` in a tight loop without pre-allocating slice capacity — use `make([]T, 0, n)`
- Flag `json.Marshal` / `json.Unmarshal` on large structs in hot paths — consider `json.Encoder` / streaming
- Flag goroutines spawned per-request without a worker pool for CPU-bound tasks
