# TypeScript / JavaScript

## Security (`security`)

- Flag `innerHTML`, `outerHTML`, `document.write()` with user-controlled data — use `textContent` or a sanitizer
- Flag `dangerouslySetInnerHTML` in React without a sanitizer
- Flag `eval()` / `new Function()` with dynamic input
- Flag JWT decoded without signature verification
- Flag missing `httpOnly` / `secure` flags on cookies

## Async / concurrency (`concurrency`)

- Flag floating promises — async calls not `await`-ed and without `.catch()`
- Flag `Promise.all()` where `Promise.allSettled()` is safer (one failure should not cancel siblings)
- Flag `async` functions inside `forEach` — `forEach` does not await; use `for...of` or `Promise.all()`
- Flag unhandled promise rejection (no global `unhandledRejection` handler in Node.js services)

## Resource management (`resources`)

- Flag `fs.createReadStream` / `fs.createWriteStream` with no `close` or `destroy` on error
- Flag `EventEmitter` listeners added in a loop without removal — memory leak
- Flag `setInterval` / `setTimeout` handles not cleared when the owning component unmounts or exits
- Flag database clients / pools not released after use in Node.js

## Exception handling (`error-handling`)

- Flag `catch (e) {}` (empty catch) — swallowed error
- Flag `catch (e)` where `e` is used as `any` without narrowing — type the error properly
- Flag `Promise` rejection not handled — `.catch()` or `try/await/catch` required
- Flag re-throwing a new `Error` without wrapping the original — loses stack context

## Performance (`performance`)

- Flag `Array.prototype.find` / `filter` / `map` chained multiple times over the same array — combine into one pass
- Flag DOM queries (`document.querySelector`) inside loops — cache the result
- Flag `JSON.parse` / `JSON.stringify` in a hot path on large objects — consider streaming or partial parsing
- Flag `async` functions called sequentially in a loop where `Promise.all()` would parallelize them
