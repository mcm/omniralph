#!/usr/bin/env node
import { main } from "./main.js";

// Exit explicitly: pending timers or sockets must not keep a stopped daemon alive.
process.exit(await main(process.argv.slice(2)));
