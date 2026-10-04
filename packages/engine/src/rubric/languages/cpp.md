# C++

## Security (`security`)

- Flag `reinterpret_cast` on user-controlled data — potential type confusion
- Flag raw array indexing without bounds check — use `.at()` or assert bounds
- Flag `std::string` data passed to C APIs without null-termination guarantee — use `.c_str()`
- Flag hardcoded buffer sizes — derive from `sizeof` or use `std::array<T, N>`
- Flag `sscanf` / `sprintf` — use `std::istringstream` or `std::format` (C++20)
- Flag user-controlled data used as a format string

## Async / concurrency (`concurrency`)

- Flag `std::shared_ptr` accessed from multiple threads — the pointer itself is not thread-safe for write; use `std::atomic<std::shared_ptr<T>>` (C++20) or external locking
- Flag `std::vector` / `std::map` mutated from multiple threads without a mutex
- Flag `std::mutex` locked twice in the same thread without `std::recursive_mutex` — deadlock
- Flag detached threads (`std::thread::detach`) with no lifetime coordination
- Flag `volatile` used instead of `std::atomic` for inter-thread communication

## Resource management (`resources`)

- Flag raw `new` returning an owning pointer — wrap immediately in `std::make_unique` or `std::make_shared`
- Flag `delete` called manually outside of a destructor or smart pointer — ownership confusion
- Flag RAII violations — resources acquired in constructor but not released via destructor
- Flag `std::ifstream` / `std::ofstream` not checked for open failure before use
- Flag exceptions thrown from destructors — causes `std::terminate` if thrown during stack unwinding

## Exception handling (`error-handling`)

- Flag `catch (...)` that swallows exceptions without logging or re-throwing
- Flag exceptions thrown from destructors — wrap in `try/catch` inside the destructor
- Flag `noexcept` on functions that can actually throw — causes `std::terminate`
- Flag exception specifications (`throw(...)`) — deprecated since C++11, removed in C++17
- Flag using exceptions for control flow in performance-critical paths

## Performance (`performance`)

- Flag pass-by-value for non-trivial types where pass-by-const-reference suffices
- Flag `std::vector::push_back` in a loop without `reserve` when size is known — repeated reallocations
- Flag `std::map` used where `std::unordered_map` would give O(1) lookup
- Flag `std::endl` in loops — prefer `'\n'` to avoid repeated buffer flushes
- Flag unnecessary copies from missing `std::move` on local temporaries being returned or passed
