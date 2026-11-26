const binaryPath = "dist/relay"
const installDirectory = Bun.env.RELAY_INSTALL_DIR ?? `${Bun.env.HOME ?? "."}/.local/bin`
const targetPath = `${installDirectory}/relay`
const stagedPath = `${targetPath}.new-${process.pid}`

const directory = Bun.spawnSync({
  cmd: ["mkdir", "-p", installDirectory],
  stdout: "ignore",
  stderr: "inherit"
})
if (directory.exitCode !== 0) {
  throw new Error(`Could not create install directory: ${installDirectory}`)
}

const binary = Bun.file(binaryPath)
if (!(await binary.exists())) {
  throw new Error(`Compiled binary not found at ${binaryPath}; run bun run compile first`)
}

await Bun.write(stagedPath, binary)
const chmod = Bun.spawnSync({
  cmd: ["chmod", "755", stagedPath],
  stdout: "ignore",
  stderr: "inherit"
})
if (chmod.exitCode !== 0) {
  throw new Error(`Could not make staged binary executable: ${stagedPath}`)
}

const install = Bun.spawnSync({
  cmd: ["mv", "-f", stagedPath, targetPath],
  stdout: "ignore",
  stderr: "inherit"
})
if (install.exitCode !== 0) {
  throw new Error(`Could not atomically install binary to ${targetPath}`)
}

console.log(`Installed Relay to ${targetPath}`)
console.log(`Run "${targetPath} --help" to get started.`)
