import {build} from 'esbuild';

// Wrangler runs this for local previews, CI dry runs, and CI deployments.
await build({
  entryPoints: ['client/app.ts'], outfile: 'public/build/app.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
