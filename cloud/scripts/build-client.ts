import {build} from 'esbuild';
import {rm} from 'node:fs/promises';

await rm('public/build', {recursive: true, force: true});

// Wrangler runs this for local previews, CI dry runs, and CI deployments.
await build({
  entryPoints: ['client/app.ts'], outdir: 'public/build', splitting: true,
  chunkNames: '[name]-[hash]',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
