import { main } from './index'

// The entry of out/cli/flockflasher.cjs (vite.cli.config.ts).
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`flockflasher: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  }
)
