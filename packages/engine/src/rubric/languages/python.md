# Python

## Security (`security`)

- Flag `eval()` / `exec()` with any user-controlled input
- Flag `pickle.loads()` on untrusted data — use `json` or `msgpack`
- Flag `subprocess` calls with `shell=True` and user input
- Flag `flask.render_template_string()` with user data (SSTI)
- Flag `SECRET_KEY` / `DEBUG = True` committed to source

## Async / concurrency (`concurrency`)

- Flag `asyncio.get_event_loop().run_until_complete()` inside an already-running loop
- Flag mixing `threading` and `asyncio` without a clear bridge (`run_in_executor`)
- Flag CPU-bound work inside an `async def` without offloading to `ProcessPoolExecutor`
- Flag `time.sleep()` inside async functions — use `await asyncio.sleep()`

## Resource management (`resources`)

- Flag `open()` not used as a context manager (`with open(...) as f`)
- Flag `requests.Session` created per-request instead of shared/reused
- Flag database connections not closed or returned to a pool on all paths
- Flag large files read entirely into memory with `.read()` — prefer streaming / chunked reads

## Exception handling (`error-handling`)

- Flag bare `except:` — catches `BaseException` including `KeyboardInterrupt` and `SystemExit`
- Flag `except Exception: pass` — silently swallows errors
- Flag re-raising with `raise e` instead of `raise` — loses the original traceback
- Flag `except` clause too broad when the `try` block covers multiple operations with different failure modes — split them

## Performance (`performance`)

- Flag `+` string concatenation in loops — use `"".join()`
- Flag repeated `re.compile()` inside a loop — compile once at module level
- Flag `list.append()` in a loop where a list comprehension would be more efficient
- Flag `in` membership tests on `list` where the collection is large — use `set`
- Flag loading entire large files into memory — prefer streaming or chunked reads
