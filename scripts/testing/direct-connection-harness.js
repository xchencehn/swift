'use strict';
require('./desktop-harness')
  .main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
