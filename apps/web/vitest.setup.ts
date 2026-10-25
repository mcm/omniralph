// Testing Library's `findBy*` and `waitFor` give up after 1s by default, which a view's
// first render can exceed when every package's suite runs at once under `pnpm test`.
import { configure } from "@testing-library/dom";

configure({ asyncUtilTimeout: 10_000 });

// Same for Redis: the client fails a command after 2s, which a loaded test Redis can exceed.
process.env.REDIS_COMMAND_TIMEOUT_MS ??= "10000";
