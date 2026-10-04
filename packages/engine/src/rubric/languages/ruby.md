# Ruby

## Security (`security`)

- Flag `eval` / `instance_eval` with user-controlled strings — remote code execution
- Flag `system()` / `exec()` / backtick calls with user-controlled input — shell injection
- Flag `YAML.load` on untrusted data — use `YAML.safe_load`
- Flag `Marshal.load` on untrusted data — arbitrary code execution
- Flag raw SQL string interpolation in ActiveRecord — use parameterized queries (`where("name = ?", name)`)
- Flag `params` passed directly to `redirect_to` without validation — open redirect
- Flag `render inline:` with user data — XSS via ERB
- Flag missing `strong_parameters` in Rails controllers — mass assignment vulnerability

## Async / concurrency (`concurrency`)

- Flag shared mutable state accessed from multiple threads without a `Mutex`
- Flag `Thread.new` without storing the thread reference — exceptions are silently swallowed
- Flag `sleep` used as a synchronization mechanism in threaded code
- Flag `@@class_variables` mutated in multi-threaded contexts — not thread-safe
- Flag Sidekiq / ActiveJob workers that are not idempotent — jobs can be retried

## Resource management (`resources`)

- Flag `File.open` without a block form — the block form guarantees `close`
- Flag database connections or HTTP clients not released in `ensure` blocks
- Flag `ActiveRecord` queries inside loops — N+1 pattern; use `includes` / `preload` / `eager_load`
- Flag `ObjectSpace` usage in production — memory and performance impact

## Exception handling (`error-handling`)

- Flag `rescue Exception` — use `rescue StandardError` or a specific exception class
- Flag empty `rescue` blocks — swallowed errors
- Flag `rescue` used for control flow (e.g. rescuing `ActiveRecord::RecordNotFound` instead of using `find_by`)
- Flag re-raising with `raise e` instead of bare `raise` — loses the original backtrace
- Flag `ensure` blocks that can raise — masks the original exception

## Performance (`performance`)

- Flag N+1 ActiveRecord queries — use `includes`, `preload`, or `eager_load`
- Flag `Array#each` with string concatenation — use `map` + `join`
- Flag `select` + `map` that could be a single `filter_map`
- Flag `.count` on an ActiveRecord relation inside a view or loop — triggers a query each time
- Flag `require` inside a method body — constant overhead on every call
- Flag `Hash#merge` in a loop — use `merge!` or `each_with_object`
