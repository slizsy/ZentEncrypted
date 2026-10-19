/** Tiny in-process event bus so REST routes can poke the realtime layer. */
module.exports = new (require('events').EventEmitter)();
