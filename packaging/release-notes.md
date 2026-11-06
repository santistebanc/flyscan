Moved the backend to TypeScript, keeping curl_cffi in a private transport worker.

- Preserves existing flight data, search queues and human verification flows.
- Bundles Node and the native curl transport with desktop installers.
- Moves launchers, release tools and regression tests to Node/TypeScript.
