# Build dependency patches

The `minimatch` 11.0.1 override fixes GHSA-g3hv-75wg-m249. `dir-compare` 4.2.0
still imports the old callable default export. Its patch uses the named
`minimatch` export without changing filter options.

The `glob` 14.0.2 override fixes GHSA-3g3m-2fjr-6pw4. `rimraf` 2.6.3, pulled
in by the Windows installer tooling, expects glob's callback API. Its patch
passes the promise result to the existing callback. The synchronous API stays
compatible.

`release-build-dependencies.test.ts` checks ASAR contents and unpacking,
directory filters, file lists, builder filters, and both cleanup APIs under Node.
Revisit these patches when the upstream consumers support the patched APIs,
or by 2027-01-31. Neither patch suppresses an advisory.
