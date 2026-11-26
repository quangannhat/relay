import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A generated workspace of services whose facts are spread across files: base ports, port overrides,
// per-service manifests with dependencies, retired services and commented-out legacy dependencies.

const BASE_NAMES = [
  "auth", "billing", "catalog", "checkout", "email", "gateway", "inventory",
  "ledger", "notify", "orders", "payments", "search", "shipping", "users"
]

export interface Service {
  readonly name: string
  readonly port: number
  readonly override: number | undefined
  readonly dependsOn: ReadonlyArray<string>
  readonly retired: boolean
}

export interface PortConflict {
  readonly port: number
  readonly services: ReadonlyArray<string>
}

// mulberry32: small deterministic PRNG so every run of a seed sees the same fixture.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const shuffle = <A>(items: ReadonlyArray<A>, next: () => number) => {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

// 14 services keeps the original names, so handoff fixtures are unchanged; larger sets add numbered variants.
const serviceNames = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    index < BASE_NAMES.length
      ? BASE_NAMES[index]!
      : `${BASE_NAMES[index % BASE_NAMES.length]}-${Math.floor(index / BASE_NAMES.length) + 1}`)

export const generateServices = (seed: number, count = BASE_NAMES.length): ReadonlyArray<Service> => {
  const next = random(seed)
  const ordered = shuffle(serviceNames(count), next)
  const retired = new Set(ordered.slice(-Math.max(2, Math.round(count / 7))))
  const active = ordered.filter(name => !retired.has(name))
  const ports = new Map(ordered.map((name, index) => [name, 7100 + index * 10]))
  // Overrides move some active services onto another service's base port, which creates conflicts.
  const overrides = new Map<string, number>()
  for (const name of shuffle(active, next).slice(0, Math.max(4, Math.round(count / 3.5)))) {
    const target = active[Math.floor(next() * active.length)]!
    overrides.set(name, target === name ? ports.get(name)! + 1 : ports.get(target)!)
  }
  return ordered.map((name, index) => {
    const earlier = active.slice(0, Math.max(0, active.indexOf(name)))
    const dependsOn = retired.has(name) || index === 0
      ? []
      : shuffle(earlier, next).slice(0, Math.floor(next() * Math.min(3, earlier.length + 1)))
    return {
      name, port: ports.get(name)!, override: overrides.get(name), dependsOn: [...dependsOn].sort(),
      retired: retired.has(name)
    }
  })
}

const activeServices = (services: ReadonlyArray<Service>) => services.filter(service => !service.retired)

export const startupOrder = (services: ReadonlyArray<Service>): ReadonlyArray<string> => {
  const remaining = new Map(activeServices(services).map(service => [service.name, new Set(service.dependsOn)]))
  const order: Array<string> = []
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort()
    const name = ready[0]
    if (!name) throw new Error("fixture has a dependency cycle")
    order.push(name)
    remaining.delete(name)
    for (const deps of remaining.values()) deps.delete(name)
  }
  return order
}

export const portConflicts = (services: ReadonlyArray<Service>): ReadonlyArray<PortConflict> => {
  const byPort = new Map<number, Array<string>>()
  for (const service of activeServices(services)) {
    const port = service.override ?? service.port
    byPort.set(port, [...(byPort.get(port) ?? []), service.name])
  }
  return [...byPort]
    .filter(([, names]) => names.length > 1)
    .map(([port, names]) => ({ port, services: names.sort() }))
    .sort((a, b) => a.port - b.port)
}

export const leafServices = (services: ReadonlyArray<Service>): ReadonlyArray<string> => {
  const active = activeServices(services)
  const dependedOn = new Set(active.flatMap(service => service.dependsOn))
  return active.map(service => service.name).filter(name => !dependedOn.has(name)).sort()
}

export const writeServices = (directory: string, services: ReadonlyArray<Service>) => {
  const envName = (name: string) => `PORT_${name.toUpperCase().replace(/-/g, "_")}`
  mkdirSync(join(directory, "config"), { recursive: true })
  writeFileSync(join(directory, "config", "ports.env"), [
    "# Base port assignments. Overrides in ports.override.env take precedence.",
    ...services.map(service => `${envName(service.name)}=${service.port}`)
  ].join("\n") + "\n")
  writeFileSync(join(directory, "config", "ports.override.env"), [
    "# Environment-specific port overrides.",
    ...services.filter(service => service.override).map(service => `${envName(service.name)}=${service.override}`)
  ].join("\n") + "\n")
  for (const service of services) {
    const serviceDirectory = join(directory, "services", service.name)
    mkdirSync(serviceDirectory, { recursive: true })
    writeFileSync(join(serviceDirectory, "manifest.yaml"), [
      `name: ${service.name}`,
      `status: ${service.retired ? "retired" : "active"}`,
      "depends_on:",
      ...(service.dependsOn.length ? service.dependsOn.map(dep => `  - ${dep}`) : ["  []"]),
      "# Historical dependencies, kept for reference only:",
      `# legacy_depends_on: [${BASE_NAMES.filter(name => name !== service.name).slice(0, 2).join(", ")}]`
    ].join("\n") + "\n")
    writeFileSync(join(serviceDirectory, "README.md"),
      `# ${service.name}\n\nOwns the ${service.name} domain. Port comes from ${envName(service.name)}.\n`)
  }
}

export const CATALOG_TASK = "List every service whose manifest status is active (skip retired services). For each one give " +
  "its name, its effective port (a value in config/ports.override.env replaces the one in config/ports.env), and its " +
  "depends_on list. Ignore commented-out legacy dependencies."

export const relayTools = (...names: ReadonlyArray<string>) => names.map(name => `mcp__relay__${name}`)

// Agents reply with JSON after a label; take the last labelled line, tolerating trailing code fences.
export const labelledJson = (text: string, label: string): unknown => {
  const line = text.split("\n").reverse().find(candidate => candidate.includes(`${label}:`))
  if (!line) throw new Error(`no ${label} line`)
  return JSON.parse(line.slice(line.indexOf(`${label}:`) + label.length + 1).trim().replace(/`+$/, ""))
}
