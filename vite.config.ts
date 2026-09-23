import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * The page learns which network serves it, and where the registry canister is,
 * from the certified `ic_env` cookie the asset canister sets. The dev server
 * sets the same cookie itself — the root key and API URL of the running local
 * network, and the registry's id — so `npm run dev` sees what the deployed page
 * sees, and proxies `/api` to the network so calls stay same-origin. The
 * registry has to be deployed first: `icp deploy registry`.
 *
 * Configured only for `serve`: a build has no network to ask.
 */
export default defineConfig(({ command }) => {
  const base = {
    root: 'src',
    publicDir: '../public', // Directory with public assets
    build: {
      outDir: '../dist', // Output to project root's dist folder
    },
  }
  if (command !== 'serve') return base

  const environment = process.env.ICP_ENVIRONMENT || 'local'
  const status = JSON.parse(
    execSync(`icp network status -e ${environment} --json`, { encoding: 'utf-8' }),
  ) as { root_key: string; api_url: string }

  let registryId: string
  try {
    registryId = execSync(`icp canister status registry -e ${environment} -i`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    console.error(`
  The registry canister is not deployed in environment "${environment}".
  The page needs it to list applications; deploy it before starting the dev server:

    icp deploy registry -e ${environment}
`)
    process.exit(1)
  }

  const env = `PUBLIC_CANISTER_ID:registry=${registryId}&ic_root_key=${status.root_key}`
  return {
    ...base,
    server: {
      headers: {
        'Set-Cookie': `ic_env=${encodeURIComponent(env)}; SameSite=Lax;`,
      },
      proxy: {
        '/api': {
          target: status.api_url,
          changeOrigin: true,
        },
      },
    },
  }
})
