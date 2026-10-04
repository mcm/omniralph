# Rust

## Security (`security`)

- Flag `unsafe` blocks accessing raw pointers without clear safety invariant documented in a comment
- Flag `std::mem::transmute` — almost always a logic error or undefined behavior; require strong justification
- Flag `from_utf8_unchecked` on user-controlled data — use `from_utf8` with error handling
- Flag `unwrap()` on user-supplied input parsing — panics are a denial-of-service vector in server code
- Flag hardcoded secrets — use environment variables or a secrets crate

## Async / concurrency (`concurrency`)

- Flag `std::sync::Mutex` used in async code — use `tokio::sync::Mutex` to avoid blocking the async runtime
- Flag `.await` inside a `std::sync::MutexGuard` scope — holds the lock across an await point, blocking other tasks
- Flag `spawn` without storing the `JoinHandle` — panics in the spawned task are silently ignored
- Flag `Arc<Mutex<T>>` cloned excessively — consider message passing via channels instead
- Flag blocking I/O calls (`std::fs`, `std::net`) inside async functions — use async equivalents

## Resource management (`resources`)

- Flag manual `drop` called explicitly where the natural scope boundary suffices
- Flag `Rc<T>` used in multi-threaded code — use `Arc<T>`; the compiler catches this but flag in review for architecture discussion
- Flag `Vec` or `String` with large pre-allocated capacity never trimmed — call `.shrink_to_fit()` if long-lived
- Flag `impl Drop` that can panic — causes `abort` during stack unwinding

## Exception handling (`error-handling`)

- Flag `.unwrap()` in production code outside of tests — use `?` to propagate or handle explicitly
- Flag `.expect("todo")` or `.expect("")` — messages must explain the invariant that guarantees safety
- Flag `panic!` used for recoverable errors — use `Result<T, E>`
- Flag `unwrap_or_default()` where the default silently masks a real error

## Performance (`performance`)

- Flag `.clone()` on large types in hot paths — review whether a reference or `Cow<T>` would work
- Flag `format!` used only to create a `String` from a literal — use `.to_string()` or `String::from`
- Flag `collect::<Vec<_>>()` followed immediately by `.iter()` — chain iterators instead
- Flag `Box<T>` for small types where stack allocation is fine
- Flag `Mutex` contention on a hot path — consider `RwLock` for read-heavy workloads or sharding
