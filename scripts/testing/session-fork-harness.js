'use strict';
// The former parent /hfork interaction was replaced by the asynchronous fork
// job API. Keep this existing command as an alias for its current UI coverage.
require('./busy-session-fork-browser-harness')
  .main()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
